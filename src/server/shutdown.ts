/**
 * Graceful shutdown (deploys, restarts). A deploy must not cut a batch off mid-send.
 *
 * Order matters:
 * 1. Stop accepting executions (refused before any claim: the plan stays runnable on the next instance) and abort
 *    normal runs, so they stop picking up new items. Close-now runs keep going: they only reduce risk.
 * 2. Drain: wait for running executions AND their result writes, up to `drainMs`.
 * 3. Past the deadline: abort everything, wait `graceMs` for calls already on the wire.
 * 4. Anything still running is marked interrupted now (pending → "not sent", sending → unknown), the same truth boot
 *    recovery would write, but without waiting for the next boot.
 * 5. Close the broker, then the database. Each step is bounded and can't stop the next one.
 *
 * Never throws: a shutdown that crashes halfway is worse than one that reports what it couldn't do.
 */
import { ignore } from "@/execution/channel";
import type { JobRunner } from "@/execution/jobRunner";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { Db } from "./db/sql";

/** Fire-and-forget work that shutdown still has to wait for (result writes). */
export class TaskTracker {
  readonly #tasks = new Set<Promise<void>>();

  track(task: Promise<unknown>): void {
    const settled = task.then(ignore, ignore);
    this.#tasks.add(settled);
    void settled.then(() => this.#tasks.delete(settled));
  }

  get size(): number {
    return this.#tasks.size;
  }

  async idle(): Promise<void> {
    // Loop: a task tracked while we waited is waited for too.
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks]);
  }
}

export interface ShutdownTarget {
  readonly runner: Pick<JobRunner, "stopAccepting" | "abortAll" | "idle" | "running">;
  readonly background: TaskTracker;
  readonly broker: Pick<BrokerProvider, "close">;
  readonly db: Db;
  readonly markInterrupted: (db: Db, executionId: string) => Promise<boolean>;
}

export interface ShutdownOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long running executions get to finish (default 15 s). The host's kill timeout must be longer. */
  readonly drainMs?: number;
  /** After aborting everything, how long in-flight calls get to answer (default 2 s). */
  readonly graceMs?: number;
  /** Bound on each close call (default 3 s). */
  readonly closeMs?: number;
}

export interface ShutdownReport {
  /** Normal runs told to stop picking up new items. */
  readonly abortedAtStart: string[];
  /** True if everything finished on its own within the drain window. */
  readonly drained: boolean;
  /** Runs still going at the end, marked interrupted. */
  readonly interrupted: string[];
  readonly errors: string[];
}

export const DRAIN_MS = 15_000;
const GRACE_MS = 2_000;
const CLOSE_MS = 3_000;

export async function shutdown(
  t: ShutdownTarget | undefined,
  opts: ShutdownOptions,
): Promise<ShutdownReport> {
  if (t === undefined) return { abortedAtStart: [], drained: true, interrupted: [], errors: [] };
  const errors: string[] = [];
  const within = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true), opts.sleep(ms).then(() => false)]);
  const settled = () => Promise.all([t.runner.idle(), t.background.idle()]);

  t.runner.stopAccepting();
  const abortedAtStart = t.runner.abortAll({ keepUrgent: true });
  const drained = await within(settled(), opts.drainMs ?? DRAIN_MS);

  const interrupted: string[] = [];
  if (!drained) {
    t.runner.abortAll();
    await within(settled(), opts.graceMs ?? GRACE_MS);
    for (const id of t.runner.running()) {
      try {
        await t.markInterrupted(t.db, id);
        interrupted.push(id);
      } catch (e) {
        errors.push(`mark ${id} interrupted: ${message(e)}`);
      }
    }
  }

  const close = async (what: string, fn: () => Promise<void>) => {
    try {
      if (!(await within(fn(), opts.closeMs ?? CLOSE_MS))) errors.push(`${what} close timed out`);
    } catch (e) {
      errors.push(`${what} close: ${message(e)}`);
    }
  };
  await close("broker", () => t.broker.close());
  await close("database", () => t.db.close());
  return { abortedAtStart, drained, interrupted, errors };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
