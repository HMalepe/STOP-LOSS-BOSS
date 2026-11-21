/**
 * Break-even and lock-profit helpers, 03-TRADING-RULES §8.
 */
import { points, tickPoints, toPoints } from "./price";
import {
  checkLevel,
  decideModify,
  ref,
  type LevelViolation,
  type Market,
  type ModifyDecision,
} from "./rules";
import type { Points, Position } from "./types";

export type HelperDecision =
  | ModifyDecision
  | { readonly kind: "skip"; readonly rule: "R8.1" | "R8.2" | "R8.3" | "R8.6" }
  | { readonly kind: "invalid"; readonly violations: readonly LevelViolation[] };

/** R8.4: snap to the tick grid in a chosen direction. */
function snap(p: number, m: Market, direction: "up" | "down"): Points {
  const t = tickPoints(m.spec);
  return points((direction === "up" ? Math.ceil(p / t) : Math.floor(p / t)) * t);
}

/** R8.3: is `candidate` a worse SL than the position already has? */
function worseThanCurrent(pos: Position, candidate: Points, m: Market): boolean {
  if (pos.sl === null) return false;
  const current = toPoints(pos.sl, m.spec);
  return pos.side === "BUY" ? candidate < current : candidate > current;
}

/** R8.1: SL = open ± N points, if it's valid now. Otherwise skip "not far enough in profit". */
export function decideBreakeven(pos: Position, offsetPoints: number, m: Market): HelperDecision {
  const open = toPoints(pos.openPrice, m.spec);
  const raw = pos.side === "BUY" ? open + offsetPoints : open - offsetPoints;
  const sl = snap(raw, m, pos.side === "BUY" ? "up" : "down");
  if (checkLevel(pos.side, "SL", sl, m) !== null) return { kind: "skip", rule: "R8.1" };
  if (worseThanCurrent(pos, sl, m)) return { kind: "skip", rule: "R8.3" };
  return decideModify(pos, { sl }, m);
}

/** R8.2: SL = price ∓ N points for in-profit positions. Invalid distance is a plan error (same for every position on a side). R8.6: never locks a loss. */
export function decideLock(pos: Position, distancePoints: number, m: Market): HelperDecision {
  if (!(pos.profit > 0)) return { kind: "skip", rule: "R8.2" };
  const r = ref(pos.side, m);
  const sl = pos.side === "BUY" ? snap(r - distancePoints, m, "down") : snap(r + distancePoints, m, "up");
  const violation = checkLevel(pos.side, "SL", sl, m);
  if (violation !== null) return { kind: "invalid", violations: [violation] };
  // R8.6: a lock that would sit on the losing side of entry isn't locking profit.
  const open = toPoints(pos.openPrice, m.spec);
  if (pos.side === "BUY" ? sl < open : sl > open) return { kind: "skip", rule: "R8.6" };
  if (worseThanCurrent(pos, sl, m)) return { kind: "skip", rule: "R8.3" };
  return decideModify(pos, { sl }, m);
}
