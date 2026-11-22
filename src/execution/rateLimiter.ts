/**
 * MetaApi credit limiter (09-PERFORMANCE): ≤ `capacity` credits in ANY `windowMs` span, plus a cap on calls in flight.
 *
 * Why a sliding window and not a token bucket: a full bucket plus its refill lets through up to 2× capacity inside one window,
 * which would trip MetaApi's 5,000 / 10 s limit. A sliding log of recent spends can't.
 *
 * Two lanes: "urgent" (close-now) is always served before "normal", FIFO within each lane, so the plan's priority order
 * (R2.10, R4.6) holds and a panic close never queues behind a bulk modify (Phase 04 board review).
 * R6.2: `pauseFor` stops everyone after a 429, capped so one bad retry time can't freeze close-now.
 */
import type { Scheduler } from "./scheduler";

export interface LimiterOptions {
  readonly capacity: number;
  readonly windowMs: number;
  /** Use only this fraction of capacity, in (0, 1] (default 0.9): headroom for reads and clock skew. */
  readonly safety?: number;
  readonly maxInFlight: number;
  readonly scheduler: Scheduler;
  /** Ceiling on any single pause (default 30 s). */
  readonly maxPauseMs?: number;
}

export type Priority = "normal" | "urgent";
export type Release = () => void;

interface Waiter {
  readonly cost: number;
  readonly priority: Priority;
  readonly seq: number;
  readonly resolve: (release: Release) => void;
}

export class CreditLimiter {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #maxInFlight: number;
  readonly #s: Scheduler;
  readonly #maxPauseMs: number;
  readonly #log: { at: number; cost: number }[] = [];
  readonly #queue: Waiter[] = [];
  #spent = 0;
  #inFlight = 0;
  #pausedUntil = 0;
  #seq = 0;
  #waking = false;
  #peakInFlight = 0;

  constructor(opts: LimiterOptions) {
    const safety = opts.safety ?? 0.9;
    if (!(opts.capacity > 0 && opts.windowMs > 0 && opts.maxInFlight >= 1 && safety > 0 && safety <= 1)) {
      throw new RangeError("invalid limiter options");
    }
    this.#budget = Math.floor(opts.capacity * safety);
    this.#windowMs = opts.windowMs;
    this.#maxInFlight = opts.maxInFlight;
    this.#s = opts.scheduler;
    this.#maxPauseMs = opts.maxPauseMs ?? 30_000;
  }

  get budget(): number {
    return this.#budget;
  }

  get peakInFlight(): number {
    return this.#peakInFlight;
  }

  /** Wait for both a credit budget and an in-flight slot. Returns the function that frees the slot. */
  acquire(cost: number, priority: Priority = "normal"): Promise<Release> {
    if (!(cost > 0) || cost > this.#budget) {
      return Promise.reject(new RangeError(`cost ${String(cost)} can never fit`));
    }
    return new Promise<Release>((resolve) => {
      this.#queue.push({ cost, priority, seq: this.#seq++, resolve });
      this.#pump();
    });
  }

  /** R6.2: nobody sends until now + ms (capped; non-numbers ignored). Returns the pause actually applied. */
  pauseFor(ms: number): number {
    if (!Number.isFinite(ms)) return 0;
    const applied = Math.min(Math.max(0, ms), this.#maxPauseMs);
    this.#pausedUntil = Math.max(this.#pausedUntil, this.#s.now() + applied);
    return applied;
  }

  /** Serve as many waiters as the budget, the pause and the in-flight cap allow, urgent lane first. */
  #pump(): void {
    for (;;) {
      const head = this.#next();
      if (head === undefined) return;
      const now = this.#s.now();
      if (now < this.#pausedUntil) {
        this.#wakeIn(this.#pausedUntil - now);
        return;
      }
      if (this.#inFlight >= this.#maxInFlight) return; // a release will pump again
      this.#expire(now);
      if (this.#spent + head.cost > this.#budget) {
        this.#wakeIn(this.#untilFits(head.cost, now));
        return;
      }
      this.#queue.splice(this.#queue.indexOf(head), 1);
      this.#log.push({ at: now, cost: head.cost });
      this.#spent += head.cost;
      this.#inFlight += 1;
      this.#peakInFlight = Math.max(this.#peakInFlight, this.#inFlight);
      head.resolve(this.#releaser());
    }
  }

  /** Urgent before normal; oldest first within a lane. */
  #next(): Waiter | undefined {
    let best: Waiter | undefined;
    for (const w of this.#queue) {
      if (best === undefined || (w.priority === "urgent" && best.priority === "normal")) best = w;
    }
    return best;
  }

  /** ms until enough old spends leave the window for `cost` to fit. */
  #untilFits(cost: number, now: number): number {
    let need = this.#spent + cost - this.#budget;
    let at = now;
    for (const entry of this.#log) {
      need -= entry.cost;
      at = entry.at + this.#windowMs;
      if (need <= 0) break;
    }
    return at - now;
  }

  #wakeIn(ms: number): void {
    if (this.#waking) return;
    this.#waking = true;
    void this.#s.sleep(ms).then(() => {
      this.#waking = false;
      this.#pump();
    });
  }

  #releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight -= 1;
      this.#pump();
    };
  }

  #expire(now: number): void {
    for (
      let first = this.#log[0];
      first !== undefined && first.at + this.#windowMs <= now;
      first = this.#log[0]
    ) {
      this.#spent -= first.cost;
      this.#log.shift();
    }
  }
}
