/**
 * Per-session request budgets for the trading routes (security review H3). A stolen or runaway session can't burn the
 * MetaApi read budget (which close-now needs) or flood the plans/audit tables. Sliding window, in memory, bounded.
 * Close-now keeps its own generous budget: the panic button must still work when everything else is throttled.
 */
import type { Clock } from "@/domain/clock";

export const BUDGETS = {
  read: { max: 30, windowMs: 5_000 },
  plan: { max: 15, windowMs: 10_000 },
  execute: { max: 10, windowMs: 10_000 },
  closeNow: { max: 6, windowMs: 10_000 },
} as const;
export type Budget = keyof typeof BUDGETS;

export class SessionLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #clock: Clock;
  readonly #maxKeys: number;

  constructor(clock: Clock, maxKeys = 10_000) {
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  /** 0 = allowed (and counted); otherwise ms to wait. */
  take(session: string, budget: Budget): number {
    const { max, windowMs } = BUDGETS[budget];
    const now = this.#clock.now();
    const key = `${session}|${budget}`;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      this.#hits.set(key, recent);
      return Math.max(1, (recent[0] ?? now) + windowMs - now);
    }
    recent.push(now);
    this.#hits.delete(key);
    this.#hits.set(key, recent);
    // Oldest-touched keys go first (Map keeps insertion order; we re-insert on every hit).
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
    return 0;
  }
}
