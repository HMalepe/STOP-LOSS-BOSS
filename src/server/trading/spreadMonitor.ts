/**
 * Spread samples for R9.4b (adaptive spread guard). For every symbol the owner previews, the stream's quote is sampled
 * every second for 10 minutes after the last use: reads of stream state, no trade credits. Each distinct tick (by quote
 * time) is one sample; only the last SPREAD_WINDOW_SEC count. Memory is bounded per symbol and in symbols.
 */
import type { Clock } from "@/domain/clock";
import { toPoints } from "@/domain/price";
import type { Quote, SymbolSpec } from "@/domain/types";

export interface SpreadMonitorOptions {
  readonly windowMs: number;
  readonly clock: Clock;
  /** Run fn every ms; returns a stop function. Real: setInterval(...).unref(). */
  readonly every: (ms: number, fn: () => void) => () => void;
  readonly pollMs?: number;
  readonly idleMs?: number;
  readonly maxPerSymbol?: number;
  readonly maxSymbols?: number;
}

interface Series {
  readonly samples: { time: number; pts: number }[];
  lastTime: number;
  stop?: () => void;
  lastUsed: number;
}

export class SpreadMonitor {
  readonly #o: Required<Omit<SpreadMonitorOptions, "every" | "clock">> &
    Pick<SpreadMonitorOptions, "every" | "clock">;
  readonly #series = new Map<string, Series>();

  constructor(o: SpreadMonitorOptions) {
    this.#o = { pollMs: 1_000, idleMs: 600_000, maxPerSymbol: 5_000, maxSymbols: 20, ...o };
  }

  get size(): number {
    return this.#series.size;
  }

  record(quote: Quote, spec: SymbolSpec): void {
    const s = this.#get(quote.symbol);
    if (quote.time === s.lastTime) return;
    s.lastTime = quote.time;
    s.samples.push({ time: quote.time, pts: toPoints(quote.ask, spec) - toPoints(quote.bid, spec) });
    if (s.samples.length > this.#o.maxPerSymbol) s.samples.splice(0, s.samples.length - this.#o.maxPerSymbol);
  }

  /** Spreads (points) of the ticks inside the window, oldest first. */
  samples(symbol: string): number[] {
    const s = this.#series.get(symbol);
    if (s === undefined) return [];
    const from = this.#o.clock.now() - this.#o.windowMs;
    const firstIn = s.samples.findIndex((x) => x.time >= from);
    if (firstIn === -1) s.samples.length = 0;
    else if (firstIn > 0) s.samples.splice(0, firstIn);
    return s.samples.map((x) => x.pts);
  }

  /** Keep sampling this symbol until it's been idle for idleMs. Calling again just marks it used. */
  watch(symbol: string, read: () => Promise<{ quote: Quote; spec: SymbolSpec }>): void {
    const s = this.#get(symbol);
    s.lastUsed = this.#o.clock.now();
    if (s.stop !== undefined) return;
    s.stop = this.#o.every(this.#o.pollMs, () => {
      if (this.#o.clock.now() - s.lastUsed > this.#o.idleMs) {
        s.stop?.();
        delete s.stop;
        return;
      }
      read().then(
        ({ quote, spec }) => {
          this.record(quote, spec);
        },
        () => undefined,
      );
    });
  }

  #get(symbol: string): Series {
    let s = this.#series.get(symbol);
    if (s === undefined) {
      // Bounded: drop the least recently used symbol (and its poller).
      if (this.#series.size >= this.#o.maxSymbols) {
        const [oldest] = [...this.#series].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        if (oldest !== undefined) {
          oldest[1].stop?.();
          this.#series.delete(oldest[0]);
        }
      }
      s = { samples: [], lastTime: Number.NaN, lastUsed: this.#o.clock.now() };
      this.#series.set(symbol, s);
    }
    return s;
  }
}
