/**
 * R9.4b spread samples. Recorded on NEW ticks only (by the quote's own time: the same stale quote is never counted twice), per symbol, in
 * integer points, inside a sliding window. Whatever reads quotes (the desk's state poll, previews, execute) feeds it; no extra credits.
 */
import { toPoints, type Grid } from "@/domain/price";
import type { Quote } from "@/domain/types";

interface Series {
  lastTick: number;
  readonly samples: { readonly t: number; readonly pts: number }[];
}

export class SpreadSampler {
  readonly #series = new Map<string, Series>();
  readonly #windowMs: number;
  readonly #maxPerSymbol: number;

  constructor(windowSec: number, maxPerSymbol = 1_000) {
    this.#windowMs = windowSec * 1_000;
    this.#maxPerSymbol = maxPerSymbol;
  }

  /** The spread of this quote in points (never a float). */
  static points(q: Pick<Quote, "bid" | "ask">, spec: Grid): number {
    return toPoints(q.ask, spec) - toPoints(q.bid, spec);
  }

  record(q: Quote, spec: Grid, nowMs: number): void {
    if (!(q.ask >= q.bid && q.bid > 0)) return; // a crossed or empty quote says nothing about the normal spread
    const s = this.#series.get(q.symbol) ?? { lastTick: -1, samples: [] };
    this.#series.set(q.symbol, s);
    if (q.time === s.lastTick) return;
    s.lastTick = q.time;
    s.samples.push({ t: nowMs, pts: SpreadSampler.points(q, spec) });
    while (s.samples.length > this.#maxPerSymbol) s.samples.shift();
  }

  /** Samples still inside the window, oldest first. */
  samples(symbol: string, nowMs: number): number[] {
    const s = this.#series.get(symbol);
    if (s === undefined) return [];
    const cutoff = nowMs - this.#windowMs;
    while (s.samples.length > 0 && (s.samples[0]?.t ?? 0) < cutoff) s.samples.shift();
    return s.samples.map((x) => x.pts);
  }
}
