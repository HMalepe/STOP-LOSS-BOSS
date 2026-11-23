/**
 * Symbol specs change rarely (stops/freeze levels, volume steps) but every plan needs one, so they're cached per symbol.
 * - Concurrent misses for one symbol share a single fetch.
 * - A failed fetch is never cached (R0.1: no spec → no plan; we don't remember the failure either, the next call retries).
 * - Entries expire after `ttlMs` so a broker-side change (e.g. stopsLevel widened before news) is picked up.
 */
import type { SymbolSpec } from "@/domain/types";
import type { Clock } from "@/domain/clock";

export class SpecCache {
  readonly #fetch: (symbol: string) => Promise<SymbolSpec>;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { readonly at: number; readonly spec: Promise<SymbolSpec> }>();

  constructor(fetch: (symbol: string) => Promise<SymbolSpec>, clock: Clock, ttlMs = 10 * 60_000) {
    this.#fetch = fetch;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  get(symbol: string): Promise<SymbolSpec> {
    const now = this.#clock.now();
    const hit = this.#entries.get(symbol);
    if (hit !== undefined && now - hit.at < this.#ttlMs) return hit.spec;
    const spec = this.#fetch(symbol);
    const entry = { at: now, spec };
    this.#entries.set(symbol, entry);
    spec.catch(() => {
      if (this.#entries.get(symbol) === entry) this.#entries.delete(symbol);
    });
    return spec;
  }

  /** Forget one symbol (or all): e.g. after the broker rejects with "invalid stops", re-read before the next plan. */
  invalidate(symbol?: string): void {
    if (symbol === undefined) this.#entries.clear();
    else this.#entries.delete(symbol);
  }
}
