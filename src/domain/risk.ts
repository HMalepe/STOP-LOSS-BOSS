/**
 * R9.2: money at risk to the stop, per order and in total, in account currency.
 *
 *   risk = |entry − SL| / tickSize × lossTickValue × lots
 *
 * The same formula MetaApi's own terminal state uses for P/L (docs/09). Entry is the expected fill for a market order
 * (buy: ask, sell: bid, as R5.3) and the order's own price for a pending one. Pure; never guesses a tick value.
 */
import type { MarketEntryItem, PendingEntryItem } from "./entries";
import { toPoints } from "./price";
import type { Quote, SymbolSpec } from "./types";

export type RiskResult =
  | {
      readonly ok: true;
      /** Per order, in plan order. null = that order has no SL. */
      readonly perOrder: readonly (number | null)[];
      /** null when any order has no SL: the risk is unbounded, never a number. */
      readonly total: number | null;
      readonly unbounded: boolean;
    }
  | { readonly ok: false; readonly message: string };

/** Up to the next cent (R9.2): rounding each order to nearest then summing can understate. 1e-9 absorbs float noise. */
const centsUp = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
const cents = (n: number) => Math.round(n * 100) / 100;

export function riskToStop(
  items: readonly (MarketEntryItem | PendingEntryItem)[],
  spec: SymbolSpec,
  quote: Quote,
  /** COMMISSION_PER_LOT in account currency (0 unless the account charges commission, e.g. raw/zero accounts). */
  commissionPerLot = 0,
): RiskResult {
  const tv = quote.lossTickValue;
  if (tv === undefined || !Number.isFinite(tv) || tv <= 0) {
    return {
      ok: false,
      message: "The broker didn't send a tick value for this symbol, so the risk can't be computed.",
    };
  }
  // Points per tick: a distance in points ÷ this = ticks (exact on the grid).
  const pointsPerTick = spec.tickSize / spec.point;
  const perOrder = items.map((i) => {
    if (i.sl === null) return null;
    const entry = i.op === "pending" ? i.openPrice : i.side === "BUY" ? quote.ask : quote.bid;
    const ticks = Math.abs(toPoints(entry, spec) - toPoints(i.sl, spec)) / pointsPerTick;
    return centsUp(ticks * tv * i.volume + commissionPerLot * i.volume);
  });
  const unbounded = perOrder.some((x) => x === null);
  return {
    ok: true,
    perOrder,
    total: unbounded ? null : cents(perOrder.reduce<number>((a, b) => a + (b ?? 0), 0)),
    unbounded,
  };
}
