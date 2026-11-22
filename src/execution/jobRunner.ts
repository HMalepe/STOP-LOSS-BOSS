/**
 * JobRunner (ADR-0003, ADR-0007): the seam between "the API accepted an execute" and "items are being sent".
 * InProcessRunner runs in the same always-on Node process.
 * - Every event gets a sequence number; a (re)connecting phone asks for events after the last one it saw (SSE Last-Event-ID)
 *   instead of replaying everything.
 * - Subscribers are removed when they stop reading; a stalled one is cut off (bounded buffer) and reconnects.
 * - Finished executions drop their event history after `retainMs`; a small status record stays (bounded).
 * - `urgent` (close-now): aborts every other running execution and takes the limiter's fast lane.
 */
import { randomUUID } from "node:crypto";
import { Channel, ignore } from "./channel";
import { execute, type ExecuteDeps } from "./executor";
import type { ExecutionStore } from "./idempotency";
import type { ExecEvent, ExecItem, Progress, Summary } from "./types";

export type StartResult =
  | { readonly ok: true; readonly executionId: string }
  /** 04-API-SPEC: PLAN_ALREADY_EXECUTED. The existing execution id is returned so the caller can follow it. */
  | { readonly ok: false; readonly code: "PLAN_ALREADY_EXECUTED"; readonly executionId: string };

export interface StartOptions {
  /** Close-now: abort other running executions and jump the rate-limit queue. */
  readonly urgent?: boolean;
}

export interface Sequenced {
  readonly seq: number;
  readonly event: ExecEvent;
}

export interface ExecutionStatus {
  readonly executionId: string;
  readonly planId: string;
  readonly state: "running" | "complete";
  readonly progress: Progress;
  readonly summary?: Summary;
  /** False once the event history has been released (status still answers). */
  readonly replayable: boolean;
}

export interface JobRunner {
  /** Items must come from the stored plan, never from the request body (the claim is keyed by planId alone). */
  start(planId: string, items: readonly ExecItem[], opts?: StartOptions): Promise<StartResult>;
  /** Events with seq > afterSeq so far, then live ones until the execution completes. Unknown or released id → empty. */
  events(executionId: string, afterSeq?: number): AsyncIterable<Sequenced>;
  status(executionId: string): ExecutionStatus | undefined;
  /** Stop sending new items. In-flight ones finish. */
  abort(executionId: string): boolean;
}

interface Execution {
  readonly planId: string;
  readonly history: Sequenced[];
  readonly subscribers: Set<Channel<Sequenced>>;
  readonly abort: AbortController;
  progress: Progress;
  summary?: Summary;
  done: boolean;
  replayable: boolean;
}

export interface InProcessRunnerDeps extends Omit<ExecuteDeps, "signal" | "priority"> {
  readonly store: ExecutionStore;
  readonly newId?: () => string;
  /** Keep a finished execution's event history this long (default 1 h). */
  readonly retainMs?: number;
  /** Max buffered events per subscriber before it's cut off (default 5,000). */
  readonly maxSubscriberBuffer?: number;
  /** Max status records kept (default 1,000). */
  readonly maxExecutions?: number;
}

export class InProcessRunner implements JobRunner {
  readonly #deps: InProcessRunnerDeps;
  readonly #executions = new Map<string, Execution>();

  constructor(deps: InProcessRunnerDeps) {
    this.#deps = deps;
  }

  async start(planId: string, items: readonly ExecItem[], opts: StartOptions = {}): Promise<StartResult> {
    const claim = await this.#deps.store.claim(planId, (this.#deps.newId ?? randomUUID)());
    if (!claim.created) return { ok: false, code: "PLAN_ALREADY_EXECUTED", executionId: claim.executionId };

    if (opts.urgent === true) {
      // When the owner hits close-all, nothing else should be spending their credits.
      for (const [id, other] of this.#executions) if (!other.done) this.abort(id);
    }
    const exec: Execution = {
      planId,
      history: [],
      subscribers: new Set(),
      abort: new AbortController(),
      progress: { total: items.length, finished: 0, done: 0, failed: 0, unknown: 0, skipped: 0 },
      done: false,
      replayable: true,
    };
    this.#executions.set(claim.executionId, exec);
    this.#prune();
    // #run finishes the execution in a finally, so nobody can wait forever even if it throws.
    this.#run(claim.executionId, exec, items, opts.urgent === true).catch(ignore);
    return { ok: true, executionId: claim.executionId };
  }

  events(executionId: string, afterSeq = -1): AsyncIterable<Sequenced> {
    const exec = this.#executions.get(executionId);
    const ch: Channel<Sequenced> = new Channel<Sequenced>({
      maxBuffer: this.#deps.maxSubscriberBuffer ?? 5_000,
      onClose: () => exec?.subscribers.delete(ch),
    });
    if (!exec?.replayable) {
      ch.close();
      return ch;
    }
    for (const e of exec.history) if (e.seq > afterSeq) ch.push(e);
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
      replayable: exec.replayable,
      ...(exec.summary === undefined ? {} : { summary: exec.summary }),
    };
  }

  abort(executionId: string): boolean {
    const exec = this.#executions.get(executionId);
    if (exec === undefined || exec.done) return false;
    exec.abort.abort();
    return true;
  }

  async #run(
    executionId: string,
    exec: Execution,
    items: readonly ExecItem[],
    urgent: boolean,
  ): Promise<void> {
    const onCall = this.#deps.onCall;
    const events = execute(items, {
      ...this.#deps,
      signal: exec.abort.signal,
      priority: urgent ? "urgent" : "normal",
      // Every log line says which execution it belongs to.
      ...(onCall === undefined
        ? {}
        : {
            onCall: (e: Parameters<typeof onCall>[0]) => {
              onCall({ ...e, executionId });
            },
          }),
    });
    try {
      for await (const event of events) {
        const sequenced = { seq: exec.history.length, event };
        exec.history.push(sequenced);
        if (event.type === "item") exec.progress = event.progress;
        else {
          exec.summary = event.summary;
          exec.progress = event.summary;
        }
        for (const ch of exec.subscribers) ch.push(sequenced);
      }
    } finally {
      this.#finish(exec);
    }
  }

  #finish(exec: Execution): void {
    exec.done = true;
    for (const ch of [...exec.subscribers]) ch.close();
    exec.subscribers.clear();
    void this.#deps.scheduler.sleep(this.#deps.retainMs ?? 3_600_000).then(() => {
      exec.history.length = 0;
      exec.replayable = false;
    });
  }

  /** Bounded status records: drop the oldest finished ones. */
  #prune(): void {
    const max = this.#deps.maxExecutions ?? 1_000;
    for (const [id, exec] of this.#executions) {
      if (this.#executions.size <= max) return;
      if (exec.done) this.#executions.delete(id);
    }
  }
}
