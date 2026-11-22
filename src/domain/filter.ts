/** §1 filters, R4.8 for pending orders. */
import type { PendingOrder, PendingType, Position, PositionFilter, Side } from "./types";

export function matchesPosition(p: Position, f: PositionFilter): boolean {
  if (p.symbol !== f.symbol) return false;
  if (f.side !== "ALL" && p.side !== f.side) return false;
  if (f.magic !== undefined && p.magic !== f.magic) return false;
  if (f.inProfitOnly === true && !(p.profit > 0)) return false;
  return true;
}

export function pendingSide(type: PendingType): Side {
  return type.startsWith("BUY_") ? "BUY" : "SELL";
}

/** R4.8: symbol, side and magic apply; inProfitOnly doesn't (orders have no P/L). */
export function matchesOrder(o: PendingOrder, f: PositionFilter): boolean {
  if (o.symbol !== f.symbol) return false;
  if (f.side !== "ALL" && pendingSide(o.type) !== f.side) return false;
  if (f.magic !== undefined && o.magic !== f.magic) return false;
  return true;
}

/** Deterministic id order (ids are unique per R0.3, so ties don't happen in plans). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** R0.3: ids that appear more than once. */
export function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].sort(compareIds);
}
