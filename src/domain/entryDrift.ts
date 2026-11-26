/**
 * §7 drift guard for ENTRIES, at execute time. The stored prices are what runs, so before the first broker call every stored level is
 * re-checked against the live market with the same rules the preview used. Any entry that is no longer valid refuses the WHOLE plan
 * (PRICE_MOVED, zero broker calls): a half-valid batch would send orders the broker rejects, or worse.
 */
import { fromPoints, toPoints } from "./price";
import { checkLevel, type Market } from "./rules";
import { levelProblem, type LadderItem } from "./ladder";
import type { EntryItem } from "./entries";
import type { Skipped } from "./types";

const word = (s: "BUY" | "SELL") => (s === "BUY" ? "buy" : "sell");

/** Distinct reasons (with how many entries share each), empty = everything is still valid. */
export function entryDrift(items: readonly (EntryItem | LadderItem)[], m: Market): Skipped[] {
  const seen = new Map<string, { first: number; count: number }>();
  const note = (reason: string, index: number) => {
    const hit = seen.get(reason);
    if (hit === undefined) seen.set(reason, { first: index, count: 1 });
    else hit.count += 1;
  };
  for (const item of items) {
    if (item.op === "market") {
      for (const [kind, level] of [
        ["SL", item.sl],
        ["TP", item.tp],
      ] as const) {
        if (level === null) continue;
        const v = checkLevel(item.side, kind, toPoints(level, m.spec), m);
        if (v !== null) {
          note(
            `${kind} for a ${word(v.side)} must now be ${v.relation} ${fromPoints(v.boundary, m.spec).toFixed(m.spec.digits)} (${v.rule})`,
            item.index,
          );
        }
      }
    } else {
      const v = levelProblem(item.type, toPoints(item.price, m.spec), m);
      if (v !== null) {
        note(
          `${item.type.replace("_", " ").toLowerCase()} at ${item.price.toFixed(m.spec.digits)} must now be ${v.relation} ${fromPoints(v.boundary, m.spec).toFixed(m.spec.digits)} (R5.5)`,
          item.index,
        );
      }
    }
  }
  return [...seen.entries()].slice(0, 5).map(([reason, { first, count }]) => ({
    id: `#${String(first)}`,
    reason: count === 1 ? reason : `${reason}; ${String(count)} orders`,
  }));
}
