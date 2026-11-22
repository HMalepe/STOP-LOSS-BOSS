/**
 * Time for the execution layer: a clock plus the ability to wait. Injected everywhere so tests and the load harness can run on
 * virtual time (deterministic, instant) while production uses the real one.
 */
import type { Clock } from "@/domain/clock";

export interface Scheduler extends Clock {
  sleep(ms: number): Promise<void>;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/**
 * Virtual time. `sleep` registers a timer; time only moves when `run()` advances it to the next timer, after letting all pending
 * promise work settle. A 20-second batch simulates in milliseconds and reports 20 virtual seconds.
 */
export class VirtualScheduler implements Scheduler {
  #now: number;
  #seq = 0;
  readonly #timers: { at: number; seq: number; resolve: () => void }[] = [];

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#timers.push({ at: this.#now + Math.max(0, ms), seq: this.#seq++, resolve });
    });
  }

  get pendingTimers(): number {
    return this.#timers.length;
  }

  /** Let every queued promise callback run (several macrotask turns, so chained awaits settle too). */
  static async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /**
   * Drive `work` to completion: settle microtasks, fire the earliest timer, repeat.
   * Throws if work is stuck with no timers left (a deadlock would otherwise hang the test).
   */
  async run<T>(work: Promise<T>, maxSteps = 1_000_000): Promise<T> {
    // An object, not loose lets: the callbacks below mutate it, and the type checker must not assume it stays false.
    const st: { done: boolean; ok: boolean; value?: T; error?: unknown } = { done: false, ok: false };
    work.then(
      (v) => {
        st.done = true;
        st.ok = true;
        st.value = v;
      },
      (e: unknown) => {
        st.done = true;
        st.error = e;
      },
    );
    const isDone = (): boolean => st.done;
    for (let step = 0; step < maxSteps && !isDone(); step++) {
      await VirtualScheduler.flush();
      if (isDone()) break;
      if (this.#timers.length === 0) {
        throw new Error("VirtualScheduler: work is stuck and no timers are pending");
      }
      // Earliest timer; ties fire in the order they were set.
      const next = this.#timers.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.seq < a.seq) ? b : a));
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = Math.max(this.#now, next.at);
      next.resolve();
    }
    if (!isDone()) throw new Error("VirtualScheduler: step limit reached");
    if (!st.ok) throw st.error instanceof Error ? st.error : new Error(String(st.error));
    return st.value as T;
  }
}
