/**
 * MetaApi credit limiter (09-PERFORMANCE): ≤ `capacity` credits in ANY `windowMs` span, plus a cap on calls in flight.
 *
 * Why a sliding window and not a token bucket: a full bucket plus its refill lets through up to 2× capacity inside one window,
 * which would trip MetaApi's 5,000 / 10 s limit. A sliding log of recent spends can't.
 *
 * Fairness: callers are served strictly in arrival order (FIFO), so the plan's priority order (R2.10, R4.6) is preserved.
 * R6.2: `pauseFor` stops everyone after a 429, honouring the server's retry time.
 */
import type { Scheduler } from "./scheduler";

export interface LimiterOptions {
  readonly capacity: number;
  readonly windowMs: number;
  /** Use only this fraction of capacity (default 0.9): headroom for reads and clock skew. */
  readonly safety?: number;
  readonly maxInFlight: number;
  readonly scheduler: Scheduler;
}

export type Release = () => void;

export class CreditLimiter {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #maxInFlight: number;
  readonly #s: Scheduler;
  readonly #log: { at: number; cost: number }[] = [];
  #spent = 0;
  #inFlight = 0;
  #pausedUntil = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #slotWaiters: (() => void)[] = [];
  #peakInFlight = 0;

  constructor(opts: LimiterOptions) {
    if (!(opts.capacity > 0 && opts.windowMs > 0 && opts.maxInFlight >= 1)) {
      throw new RangeError("invalid limiter options");
    }
    this.#budget = Math.floor(opts.capacity * (opts.safety ?? 0.9));
    this.#windowMs = opts.windowMs;
    this.#maxInFlight = opts.maxInFlight;
    this.#s = opts.scheduler;
  }

  get budget(): number {
    return this.#budget;
  }

  get peakInFlight(): number {
    return this.#peakInFlight;
  }

  /** Wait for both a credit budget and an in-flight slot. Returns the function that frees the slot. */
  acquire(cost: number): Promise<Release> {
    if (!(cost > 0) || cost > this.#budget) {
      return Promise.reject(new RangeError(`cost ${String(cost)} can never fit`));
    }
    const turn = this.#tail.then(() => this.#waitAndTake(cost));
    // The next caller queues behind this one whatever happens to it.
    this.#tail = Promise.allSettled([turn]).then(() => undefined);
    return turn;
  }

  /** R6.2: nobody sends until now + ms. */
  pauseFor(ms: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#s.now() + Math.max(0, ms));
  }

  async #waitAndTake(cost: number): Promise<Release> {
    for (;;) {
      const now = this.#s.now();
      if (now < this.#pausedUntil) {
        await this.#s.sleep(this.#pausedUntil - now);
        continue;
      }
      if (this.#inFlight >= this.#maxInFlight) {
        await new Promise<void>((resolve) => this.#slotWaiters.push(resolve));
        continue;
      }
      this.#expire(now);
      if (this.#spent + cost <= this.#budget) {
        this.#log.push({ at: now, cost });
        this.#spent += cost;
        this.#inFlight += 1;
        this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.#inFlight -= 1;
          this.#slotWaiters.shift()?.();
        };
      }
      // Wait until enough old spends leave the window.
      let need = this.#spent + cost - this.#budget;
      let waitUntil = now;
      for (const entry of this.#log) {
        need -= entry.cost;
        waitUntil = entry.at + this.#windowMs;
        if (need <= 0) break;
      }
      await this.#s.sleep(waitUntil - now);
    }
  }

  #expire(now: number): void {
    while (this.#log.length > 0 && (this.#log[0]?.at ?? now) + this.#windowMs <= now) {
      this.#spent -= this.#log.shift()?.cost ?? 0;
    }
  }
}
