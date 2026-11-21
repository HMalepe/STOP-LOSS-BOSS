/**
 * Time enters the domain only through a Clock, so every rule that depends on time
 * (plan TTL, spread windows, backoff) is deterministic under test.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

/** A clock that only moves when told to. Use in tests and simulations. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(startMs = 0) {
    if (!Number.isFinite(startMs)) throw new RangeError("ManualClock start must be a finite number");
    this.#ms = startMs;
  }

  now(): number {
    return this.#ms;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("ManualClock can only move forward");
    this.#ms += ms;
  }
}
