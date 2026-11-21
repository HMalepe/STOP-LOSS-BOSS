/**
 * Level rules, 03-TRADING-RULES §0 and §2. Everything is in integer points.
 */
import { invariant } from "./invariant";
import { points, toPoints } from "./price";
import type { Points, Position, Quote, Side, SymbolSpec } from "./types";

/** §0 default safety buffer on top of the broker's stops/freeze level. */
export const DEFAULT_BUFFER_POINTS = 2;

/** One symbol's market state, in points. Build with marketFrom after checking spec and quote. */
export interface Market {
  readonly spec: SymbolSpec;
  readonly bid: Points;
  readonly ask: Points;
  /** §0 minimum distance for a new level: max(stopsLevel, freezeLevel) + buffer. */
  readonly d: Points;
  /** R2.9 freeze distance for existing levels. 0 = no freeze. */
  readonly freeze: Points;
}

/** Problems with a quote that make it unusable (R0.1 spirit: no trustworthy data, no plan). */
export function quoteProblems(q: Quote): string[] {
  const problems: string[] = [];
  if (!(Number.isFinite(q.bid) && q.bid > 0)) problems.push("bid must be > 0");
  if (!(Number.isFinite(q.ask) && q.ask > 0)) problems.push("ask must be > 0");
  if (problems.length === 0 && q.ask < q.bid) problems.push("ask must be ≥ bid");
  return problems;
}

/** §0 d, in points. */
export function stopDistance(spec: SymbolSpec, bufferPoints: number = DEFAULT_BUFFER_POINTS): Points {
  return points(Math.max(spec.stopsLevel, spec.freezeLevel) + bufferPoints);
}

/** Caller must have checked specProblems and quoteProblems first. */
export function marketFrom(
  spec: SymbolSpec,
  quote: Quote,
  bufferPoints: number = DEFAULT_BUFFER_POINTS,
): Market {
  invariant(quote.symbol === spec.symbol, `quote ${quote.symbol} does not match spec ${spec.symbol}`);
  invariant(Number.isSafeInteger(bufferPoints) && bufferPoints >= 0, "buffer must be an integer ≥ 0");
  return {
    spec,
    bid: toPoints(quote.bid, spec),
    ask: toPoints(quote.ask, spec),
    d: stopDistance(spec, bufferPoints),
    freeze: points(spec.freezeLevel),
  };
}

/** §0: a buy closes at bid, a sell closes at ask. */
export function ref(side: Side, m: Market): Points {
  return side === "BUY" ? m.bid : m.ask;
}

export type LevelKind = "SL" | "TP";

export interface LevelViolation {
  readonly rule: "R2.1" | "R2.2" | "R2.3" | "R2.4";
  readonly side: Side;
  readonly level: LevelKind;
  /** The level must be strictly beyond this, in the direction of `relation`. */
  readonly boundary: Points;
  readonly relation: "below" | "above";
}

/** R2.1 to R2.4 for one level. null = valid. */
export function checkLevel(side: Side, level: LevelKind, value: Points, m: Market): LevelViolation | null {
  const r = ref(side, m);
  const below = points(r - m.d);
  const above = points(r + m.d);
  if (side === "BUY" && level === "SL") {
    return value < below ? null : { rule: "R2.1", side, level, boundary: below, relation: "below" };
  }
  if (side === "BUY") {
    return value > above ? null : { rule: "R2.2", side, level, boundary: above, relation: "above" };
  }
  if (level === "SL") {
    return value > above ? null : { rule: "R2.3", side, level, boundary: above, relation: "above" };
  }
  return value < below ? null : { rule: "R2.4", side, level, boundary: below, relation: "below" };
}

export interface LevelChange {
  readonly sl?: Points;
  readonly tp?: Points;
}

/** R2.1 to R2.5 for a change. Empty array = valid. */
export function validateLevels(side: Side, change: LevelChange, m: Market): LevelViolation[] {
  const violations: LevelViolation[] = [];
  if (change.sl !== undefined) {
    const v = checkLevel(side, "SL", change.sl, m);
    if (v !== null) violations.push(v);
  }
  if (change.tp !== undefined) {
    const v = checkLevel(side, "TP", change.tp, m);
    if (v !== null) violations.push(v);
  }
  if (violations.length === 0 && change.sl !== undefined && change.tp !== undefined) {
    // R2.5: implied by R2.1-R2.4 because d ≥ 0. Asserted anyway: if this fires, the maths above is broken.
    invariant(side === "BUY" ? change.sl < change.tp : change.sl > change.tp, "R2.5 SL/TP order");
  }
  return violations;
}

const currentPoints = (value: number | null, m: Market): Points | null =>
  value === null ? null : toPoints(value, m.spec);

/** R2.7: both levels, always. New value if set, else current, else null ("none"). */
export function mergeLevels(
  pos: Position,
  change: LevelChange,
  m: Market,
): { readonly sl: Points | null; readonly tp: Points | null } {
  return {
    sl: change.sl ?? currentPoints(pos.sl, m),
    tp: change.tp ?? currentPoints(pos.tp, m),
  };
}

/** The part of a change that actually differs from the position's current levels. */
export function effectiveChange(pos: Position, change: LevelChange, m: Market): LevelChange {
  const curSl = currentPoints(pos.sl, m);
  const curTp = currentPoints(pos.tp, m);
  return {
    ...(change.sl !== undefined && change.sl !== curSl ? { sl: change.sl } : {}),
    ...(change.tp !== undefined && change.tp !== curTp ? { tp: change.tp } : {}),
  };
}

/** R2.9: an existing level within the freeze distance of price makes the position unmodifiable. */
export function frozenLevel(pos: Position, m: Market): LevelKind | null {
  if (m.freeze === 0) return null;
  const r = ref(pos.side, m);
  for (const [kind, value] of [
    ["SL", pos.sl],
    ["TP", pos.tp],
  ] as const) {
    const p = currentPoints(value, m);
    if (p !== null && Math.abs(p - r) <= m.freeze) return kind;
  }
  return null;
}

export type ModifyDecision =
  | { readonly kind: "modify"; readonly sl: Points | null; readonly tp: Points | null }
  | { readonly kind: "skip"; readonly rule: "R2.8" | "R2.9"; readonly frozen?: LevelKind }
  | { readonly kind: "invalid"; readonly violations: readonly LevelViolation[] };

/**
 * What happens to one position for a requested level change.
 * Order: no-op (R2.8) → validity of the levels that actually change (R2.1-R2.5) → frozen (R2.9) → modify with both levels (R2.7).
 */
export function decideModify(pos: Position, change: LevelChange, m: Market): ModifyDecision {
  invariant(pos.symbol === m.spec.symbol, `position ${pos.id} is ${pos.symbol}, market is ${m.spec.symbol}`);
  const eff = effectiveChange(pos, change, m);
  if (eff.sl === undefined && eff.tp === undefined) return { kind: "skip", rule: "R2.8" };

  const violations = validateLevels(pos.side, eff, m);
  if (violations.length > 0) return { kind: "invalid", violations };

  const frozen = frozenLevel(pos, m);
  if (frozen !== null) return { kind: "skip", rule: "R2.9", frozen };

  return { kind: "modify", ...mergeLevels(pos, eff, m) };
}
