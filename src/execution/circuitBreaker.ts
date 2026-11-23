/**
 * Circuit breaker for broker outages (carry-over from the Phase 04 SRE review).
 *
 * Without it, a dead connection makes a 1,000-item batch grind through 1,000 × (attempts × backoff) before the owner
 * learns anything. With it: after `threshold` consecutive connection failures, items that haven't been sent fail at
 * once as "not sent: broker unavailable" (retryable later), before spending credits.
 *
 * closed → (threshold consecutive connection failures) → open
 * open → (cooldown elapsed AND one shared health probe says healthy) → halfOpen
 * halfOpen → (any real answer) → closed · (one connection failure) → open, fresh cooldown
 *
 * The probe is `broker.health()`: stream state, no trade credits. One runner-wide instance: an outage hits every batch.
 */
import type { TradeResult } from "@/broker/BrokerProvider";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import type { Clock } from "@/domain/clock";

export type BreakerState = "closed" | "open" | "halfOpen";

/** The broker (or MetaApi) couldn't be reached or didn't answer. A refusal, even a final one, is an answer. */
const CONNECTION_FAILURES = new Set<number>([
  LOCAL_CODE.NOT_CONNECTED,
  LOCAL_CODE.ADAPTER_TIMEOUT,
  RETCODE.TIMEOUT,
  RETCODE.CONNECTION,
]);
export const isConnectionFailure = (r: TradeResult): boolean => CONNECTION_FAILURES.has(r.code);

export interface BreakerOptions {
  /** Consecutive connection failures that open the breaker (default 5). */
  readonly threshold?: number;
  /** How long it stays open before a probe is allowed (default 5 s). */
  readonly cooldownMs?: number;
  readonly clock: Clock;
  /** true = healthy enough to try again. A throw counts as unhealthy. */
  readonly probe: () => Promise<boolean>;
  /** Called on every state transition (observability). Must not throw; if it does, it's ignored. */
  readonly onChange?: (state: BreakerState, reason: string) => void;
}

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;
  readonly #probe: () => Promise<boolean>;
  readonly #onChange: ((state: BreakerState, reason: string) => void) | undefined;
  #state: BreakerState = "closed";
  #failures = 0;
  #openedAt = 0;
  #probing: Promise<boolean> | undefined;

  constructor(o: BreakerOptions) {
    this.#threshold = Math.max(1, Math.floor(o.threshold ?? 5));
    this.#cooldownMs = Math.max(0, o.cooldownMs ?? 5_000);
    this.#clock = o.clock;
    this.#probe = o.probe;
    this.#onChange = o.onChange;
  }

  get state(): BreakerState {
    return this.#state;
  }

  /** Feed every broker result. */
  record(r: TradeResult): void {
    if (!isConnectionFailure(r)) {
      this.#failures = 0;
      this.#set("closed");
      return;
    }
    this.#failures += 1;
    if (this.#state === "halfOpen" || this.#failures >= this.#threshold) this.#open();
  }

  /** May an item be sent now? Open → false, except one shared probe after the cooldown. */
  async allow(): Promise<boolean> {
    if (this.#state !== "open") return true;
    if (this.#clock.now() - this.#openedAt < this.#cooldownMs) return false;
    this.#probing ??= this.#runProbe();
    return this.#probing;
  }

  reason(): string {
    return `broker unavailable (${String(this.#failures)} connection failures in a row)`;
  }

  #open(): void {
    this.#openedAt = this.#clock.now();
    this.#set("open");
  }

  #set(state: BreakerState): void {
    if (state === this.#state) return;
    this.#state = state;
    try {
      this.#onChange?.(state, state === "open" ? this.reason() : "");
    } catch {
      // A listener bug must never change whether trades go out.
    }
  }

  async #runProbe(): Promise<boolean> {
    let healthy: boolean;
    try {
      healthy = await this.#probe();
    } catch {
      healthy = false;
    }
    this.#probing = undefined;
    if (this.#state !== "open") return true; // a real answer closed it while we probed
    if (!healthy) {
      this.#open();
      return false;
    }
    this.#set("halfOpen");
    return true;
  }
}
