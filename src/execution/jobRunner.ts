/**
 * JobRunner (ADR-0003, ADR-0007): the seam between "the API accepted an execute" and "items are being sent".
 * InProcessRunner runs in the same always-on Node process. Each execution keeps its full event history, so a phone that
 * (re)connects late still gets every event from the start (SSE replay), then live ones.
 */
import { randomUUID } from "node:crypto";
import { Channel } from "./channel";
import { execute, type ExecuteDeps } from "./executor";
import type { ExecutionStore } from "./idempotency";
import type { ExecEvent, ExecItem, Progress, Summary } from "./types";

export type StartResult =
  | { readonly ok: true; readonly executionId: string }
  /** 04-API-SPEC: PLAN_ALREADY_EXECUTED. The existing execution id is returned so the caller can follow it. */
  | { readonly ok: false; readonly code: "PLAN_ALREADY_EXECUTED"; readonly executionId: string };

export interface ExecutionStatus {
  readonly executionId: string;
  readonly planId: string;
  readonly state: "running" | "complete";
  readonly progress: Progress;
  readonly summary?: Summary;
}

export interface JobRunner {
  start(planId: string, items: readonly ExecItem[]): Promise<StartResult>;
  /** Every event so far, then live ones until the execution completes. Unknown id → empty. */
  events(executionId: string): AsyncIterable<ExecEvent>;
  status(executionId: string): ExecutionStatus | undefined;
  /** Stop sending new items. In-flight ones finish. */
  abort(executionId: string): boolean;
}

interface Execution {
  readonly planId: string;
  readonly history: ExecEvent[];
  readonly subscribers: Set<Channel<ExecEvent>>;
  readonly abort: AbortController;
  progress: Progress;
  summary?: Summary;
  done: boolean;
}

export interface InProcessRunnerDeps extends Omit<ExecuteDeps, "signal"> {
  readonly store: ExecutionStore;
  readonly newId?: () => string;
}

export class InProcessRunner implements JobRunner {
  readonly #deps: InProcessRunnerDeps;
  readonly #executions = new Map<string, Execution>();

  constructor(deps: InProcessRunnerDeps) {
    this.#deps = deps;
  }

  async start(planId: string, items: readonly ExecItem[]): Promise<StartResult> {
    const claim = await this.#deps.store.claim(planId, (this.#deps.newId ?? randomUUID)());
    if (!claim.created) return { ok: false, code: "PLAN_ALREADY_EXECUTED", executionId: claim.executionId };

    const exec: Execution = {
      planId,
      history: [],
      subscribers: new Set(),
      abort: new AbortController(),
      progress: { total: items.length, finished: 0, done: 0, failed: 0, unknown: 0, skipped: 0 },
      done: false,
    };
    this.#executions.set(claim.executionId, exec);
    void this.#run(exec, items);
    return { ok: true, executionId: claim.executionId };
  }

  events(executionId: string): AsyncIterable<ExecEvent> {
    const ch = new Channel<ExecEvent>();
    const exec = this.#executions.get(executionId);
    if (exec === undefined) {
      ch.close();
      return ch;
    }
    for (const e of exec.history) ch.push(e);
    if (exec.done) ch.close();
    else exec.subscribers.add(ch);
    return ch;
  }

  status(executionId: string): ExecutionStatus | undefined {
    const exec = this.#executions.get(executionId);
    if (exec === undefined) return undefined;
    return {
      executionId,
      planId: exec.planId,
      state: exec.done ? "complete" : "running",
      progress: exec.progress,
      ...(exec.summary === undefined ? {} : { summary: exec.summary }),
    };
  }

  abort(executionId: string): boolean {
    const exec = this.#executions.get(executionId);
    if (exec === undefined || exec.done) return false;
    exec.abort.abort();
    return true;
  }

  async #run(exec: Execution, items: readonly ExecItem[]): Promise<void> {
    for await (const event of execute(items, { ...this.#deps, signal: exec.abort.signal })) {
      exec.history.push(event);
      if (event.type === "item") exec.progress = event.progress;
      else {
        exec.summary = event.summary;
        exec.progress = event.summary;
      }
      for (const ch of exec.subscribers) ch.push(event);
    }
    exec.done = true;
    for (const ch of exec.subscribers) ch.close();
    exec.subscribers.clear();
  }
}
