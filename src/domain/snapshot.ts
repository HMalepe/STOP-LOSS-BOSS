/** R0.5 snapshot sanity: broker data the rules can trust. Messages name the ticket and field, never guess a value. */
import { representable, type Grid } from "./price";
import type { PendingOrder, Position } from "./types";

const positive = (n: number) => Number.isFinite(n) && n > 0;
const levelOk = (n: number | null) => n === null || positive(n);
const magicOk = (n: number) => Number.isSafeInteger(n) && n >= 0;

export function positionProblems(p: Position): string[] {
  const id = p.id === "" ? "(no id)" : p.id;
  const problems: string[] = [];
  if (p.id === "") problems.push("position with an empty id");
  if (!positive(p.openPrice)) problems.push(`position ${id}: openPrice`);
  if (!positive(p.volume)) problems.push(`position ${id}: volume`);
  if (!Number.isFinite(p.profit)) problems.push(`position ${id}: profit`);
  if (!levelOk(p.sl)) problems.push(`position ${id}: sl`);
  if (!levelOk(p.tp)) problems.push(`position ${id}: tp`);
  if (!magicOk(p.magic)) problems.push(`position ${id}: magic`);
  return problems;
}

export function orderProblems(o: PendingOrder): string[] {
  const id = o.id === "" ? "(no id)" : o.id;
  const problems: string[] = [];
  if (o.id === "") problems.push("order with an empty id");
  if (!positive(o.openPrice)) problems.push(`order ${id}: openPrice`);
  if (!positive(o.volume)) problems.push(`order ${id}: volume`);
  if (!levelOk(o.sl)) problems.push(`order ${id}: sl`);
  if (!levelOk(o.tp)) problems.push(`order ${id}: tp`);
  if (!magicOk(o.magic)) problems.push(`order ${id}: magic`);
  return problems;
}

/** Keep the first of each id. */
export function uniqueById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * R0.5 on the symbol's grid: prices must be representable and at least 1 point.
 * (A "positive" SL of 0.000004 is 0 points on EURUSD, i.e. "no SL" on the wire.)
 */
export function positionGridProblems(p: Position, grid: Grid): string[] {
  const atLeastOnePoint = (n: number) => representable(n, grid) && Math.round(n / grid.point) >= 1;
  const problems: string[] = [];
  if (!atLeastOnePoint(p.openPrice)) problems.push(`position ${p.id}: openPrice off the price grid`);
  if (p.sl !== null && !atLeastOnePoint(p.sl)) problems.push(`position ${p.id}: sl off the price grid`);
  if (p.tp !== null && !atLeastOnePoint(p.tp)) problems.push(`position ${p.id}: tp off the price grid`);
  return problems;
}
