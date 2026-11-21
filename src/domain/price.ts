/**
 * Price arithmetic (03-TRADING-RULES §0). The only file allowed to compare prices directly:
 * everywhere else uses these helpers (lint rule order-desk/no-raw-price-compare).
 *
 * Strategy: convert to integer points as early as possible, do all maths and comparisons on integers,
 * convert back to a Price only for output. 1.1 + 0.2 !== 1.3 in floats, but both are 130000 points.
 */
import type { Points, Price, SymbolSpec } from "./types";

export type Grid = Pick<SymbolSpec, "point" | "digits" | "tickSize">;

/** Brand an integer as Points. Throws on anything that isn't a safe integer: that's a bug upstream. */
export function points(n: number): Points {
  if (!Number.isSafeInteger(n)) throw new RangeError(`points must be a safe integer, got ${n}`);
  return n as Points;
}

export function toPoints(price: number, grid: Grid): Points {
  if (!Number.isFinite(price)) throw new RangeError(`price must be finite, got ${price}`);
  return points(Math.round(price / grid.point));
}

export function fromPoints(p: Points, grid: Grid): Price {
  return Number((p * grid.point).toFixed(grid.digits)) as Price;
}

/** How many points one tick spans (≥ 1). */
export function tickPoints(grid: Grid): number {
  return Math.max(1, Math.round(grid.tickSize / grid.point));
}

/**
 * Nearest tick, in points, or null if the price can't be represented (non-finite, or too large for exact integers).
 * Rounds once, straight to the tick (rounding to point first, then to tick, can pick the wrong tick). Ties round up.
 */
export function tryRoundToTickPoints(price: number, grid: Grid): Points | null {
  if (!Number.isFinite(price)) return null;
  const t = tickPoints(grid);
  const n = Math.round(price / (t * grid.point)) * t;
  return Number.isSafeInteger(n) ? (n as Points) : null;
}

/** Nearest tick, in points. Throws on unrepresentable input: validate with tryRoundToTickPoints first. */
export function roundToTickPoints(price: number, grid: Grid): Points {
  const p = tryRoundToTickPoints(price, grid);
  if (p === null) throw new RangeError(`price ${price} can't be placed on the tick grid`);
  return p;
}

/** True if this raw broker price converts to exact integer points. */
export function representable(price: number, grid: Grid): boolean {
  return Number.isFinite(price) && Number.isSafeInteger(Math.round(price / grid.point));
}

export function roundToTick(price: number, grid: Grid): Price {
  return fromPoints(roundToTickPoints(price, grid), grid);
}

export function comparePrices(a: Price, b: Price, grid: Grid): -1 | 0 | 1 {
  const d = toPoints(a, grid) - toPoints(b, grid);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

export function pricesEqual(a: Price, b: Price, grid: Grid): boolean {
  return comparePrices(a, b, grid) === 0;
}

export function formatPrice(p: Price, grid: Grid): string {
  return p.toFixed(grid.digits);
}

/** R0.1: a spec we can't trust is a spec we don't use. Returns every problem found (empty = OK). */
export function specProblems(spec: SymbolSpec): string[] {
  const problems: string[] = [];
  const positiveFinite = (n: number) => Number.isFinite(n) && n > 0;
  const nonNegInt = (n: number) => Number.isSafeInteger(n) && n >= 0;

  if (!Number.isInteger(spec.digits) || spec.digits < 0 || spec.digits > 10) {
    problems.push("digits must be an integer 0..10");
  }
  if (!positiveFinite(spec.point)) {
    problems.push("point must be > 0");
  } else if (Number.isInteger(spec.digits) && Math.abs(spec.point * 10 ** spec.digits - 1) > 1e-9) {
    problems.push("point must equal 10^-digits");
  }
  if (!positiveFinite(spec.tickSize)) {
    problems.push("tickSize must be > 0");
  } else if (positiveFinite(spec.point)) {
    const ratio = spec.tickSize / spec.point;
    if (ratio < 1 - 1e-9 || Math.abs(ratio - Math.round(ratio)) > 1e-6) {
      problems.push("tickSize must be a whole multiple of point");
    }
  }
  if (!nonNegInt(spec.stopsLevel)) problems.push("stopsLevel must be an integer ≥ 0");
  if (!nonNegInt(spec.freezeLevel)) problems.push("freezeLevel must be an integer ≥ 0");
  if (!positiveFinite(spec.volumeMin)) problems.push("volumeMin must be > 0");
  if (!positiveFinite(spec.volumeStep)) problems.push("volumeStep must be > 0");
  if (!(Number.isFinite(spec.volumeMax) && spec.volumeMax >= spec.volumeMin)) {
    problems.push("volumeMax must be ≥ volumeMin");
  }
  return problems;
}
