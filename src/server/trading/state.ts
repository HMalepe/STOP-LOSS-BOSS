/**
 * Read models for GET /api/state and GET /api/positions (docs/04). Everything is read fresh from the broker, in parallel;
 * only the symbol spec comes from the cache. Broker reads throw BrokerError when untrustworthy: the route turns that into
 * BROKER_UNAVAILABLE, never into stale or partial data.
 */
import type { AccountInfo } from "@/broker/BrokerProvider";
import { compareIds, matchesPosition } from "@/domain/filter";
import type { PendingOrder, Position, PositionFilter, Quote, SymbolSpec } from "@/domain/types";
import type { KillSwitchState } from "../killSwitch";
import type { TradingMode } from "../env";
import type { TradingServices } from "./services";

export interface SideSummary {
  readonly count: number;
  readonly lots: number;
  readonly profit: number;
}

export interface SymbolSummary {
  readonly symbol: string;
  readonly buy: SideSummary;
  readonly sell: SideSummary;
  readonly orders: number;
}

export interface StateView {
  readonly mode: TradingMode;
  readonly killSwitch: KillSwitchState;
  readonly account: AccountInfo;
  readonly symbols: readonly SymbolSummary[];
  readonly positions: number;
  readonly orders: number;
  /** Present when a symbol was asked for. */
  readonly focus?: { readonly symbol: string; readonly quote: Quote; readonly spec: SymbolSpec };
}

/** Sums in integer cents / micro-lots so 0.1 + 0.2 never shows as 0.30000000000000004. */
const sumTo = (values: readonly number[], scale: number) =>
  Math.round(values.reduce((a, v) => a + Math.round(v * scale), 0)) / scale;

function side(ps: readonly Position[]): SideSummary {
  return {
    count: ps.length,
    lots: sumTo(
      ps.map((p) => p.volume),
      1e6,
    ),
    profit: sumTo(
      ps.map((p) => p.profit),
      100,
    ),
  };
}

export function summarise(positions: readonly Position[], orders: readonly PendingOrder[]): SymbolSummary[] {
  const symbols = [...new Set([...positions.map((p) => p.symbol), ...orders.map((o) => o.symbol)])].sort();
  return symbols.map((symbol) => {
    const mine = positions.filter((p) => p.symbol === symbol);
    return {
      symbol,
      buy: side(mine.filter((p) => p.side === "BUY")),
      sell: side(mine.filter((p) => p.side === "SELL")),
      orders: orders.filter((o) => o.symbol === symbol).length,
    };
  });
}

export async function loadState(
  svc: TradingServices,
  killSwitch: KillSwitchState,
  symbol: string | undefined,
): Promise<StateView> {
  const [account, positions, orders, focus] = await Promise.all([
    svc.broker.getAccount(),
    svc.broker.getPositions(),
    svc.broker.getOrders(),
    symbol === undefined
      ? Promise.resolve(undefined)
      : Promise.all([svc.broker.getQuote(symbol), svc.specs.get(symbol)]).then(([quote, spec]) => ({
          symbol,
          quote,
          spec,
        })),
  ]);
  return {
    mode: svc.mode,
    killSwitch,
    account,
    symbols: summarise(positions, orders),
    positions: positions.length,
    orders: orders.length,
    ...(focus === undefined ? {} : { focus }),
  };
}

export const PAGE_SIZE = 500;

export interface PositionsPage {
  readonly items: readonly Position[];
  readonly total: number;
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** Stable order (ticket ascending, the same order plans use) so a cursor is just the last id seen. */
export function pagePositions(
  all: readonly Position[],
  filter: PositionFilter | { readonly symbol?: undefined; readonly side: "ALL" | "BUY" | "SELL" },
  cursor: string | undefined,
  limit = PAGE_SIZE,
): PositionsPage {
  const matching = all
    .filter((p) =>
      filter.symbol === undefined
        ? filter.side === "ALL" || p.side === filter.side
        : matchesPosition(p, filter),
    )
    .sort((a, b) => compareIds(a.id, b.id));
  const start = cursor === undefined ? 0 : matching.findIndex((p) => compareIds(p.id, cursor) > 0);
  const from = start === -1 ? matching.length : start;
  const items = matching.slice(from, from + limit);
  const last = items.at(-1);
  return {
    items,
    total: matching.length,
    nextCursor: from + limit < matching.length && last !== undefined ? last.id : null,
  };
}
