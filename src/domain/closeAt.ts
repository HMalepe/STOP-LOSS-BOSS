/**
 * Close-at-price trigger, 03-TRADING-RULES §3. One price X becomes each position's TP or SL,
 * whichever side of its closing price X is on. Held at the broker (ADR-0001).
 */
import { decideModify, ref, type LevelKind, type Market, type ModifyDecision } from "./rules";
import type { Points, Position, Side } from "./types";

export type CloseAtAssignment =
  | { readonly kind: "assign"; readonly set: LevelKind }
  | { readonly kind: "tooClose"; readonly rule: "R3.1"; readonly ref: Points; readonly d: Points };

/** R3.1 and R3.2 for one side. */
export function assignCloseAt(side: Side, x: Points, m: Market): CloseAtAssignment {
  const r = ref(side, m);
  if (Math.abs(x - r) <= m.d) return { kind: "tooClose", rule: "R3.1", ref: r, d: m.d };
  const above = x > r;
  // Buy: above → TP, below → SL. Sell: above → SL, below → TP.
  const asTP = side === "BUY" ? above : !above;
  return { kind: "assign", set: asTP ? "TP" : "SL" };
}

export type CloseAtDecision =
  (ModifyDecision & { readonly set: LevelKind }) | Extract<CloseAtAssignment, { kind: "tooClose" }>;

/** R3.1 to R3.3 for one position: assign, then run the §2 pipeline (R2.7 preserve, R2.8 no-op, R2.9 frozen). */
export function decideCloseAt(pos: Position, x: Points, m: Market): CloseAtDecision {
  const assignment = assignCloseAt(pos.side, x, m);
  if (assignment.kind === "tooClose") return assignment;
  const change = assignment.set === "TP" ? { tp: x } : { sl: x };
  return { ...decideModify(pos, change, m), set: assignment.set };
}
