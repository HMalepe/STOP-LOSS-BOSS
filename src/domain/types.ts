/**
 * Core domain types. Broker data is parsed into these by src/broker (Zod) before the domain sees it.
 * Conventions:
 * - "No level" is `null`, never 0. (MT5 uses 0 for "none"; the broker adapter maps it.)
 * - Raw broker prices are plain numbers. A `Price` has been rounded to the symbol's tick grid.
 * - `Points` are integers. All rule math happens in Points, so float noise can't flip a comparison.
 */

/** A price that is already on the symbol's tick grid. Make one with roundToTick / fromPoints. */
export type Price = number & { readonly __brand: "Price" };

/** An integer number of symbol points. Make one with points() / toPoints. */
export type Points = number & { readonly __brand: "Points" };

export type Side = "BUY" | "SELL";

export interface SymbolSpec {
  readonly symbol: string;
  /** Decimal places. MT5 defines point = 10^-digits. */
  readonly digits: number;
  readonly point: number;
  /** Minimal price change. A multiple of point (often equal on FX). */
  readonly tickSize: number;
  /** Minimum SL/TP distance from the closing price, in points. 0 = none. */
  readonly stopsLevel: number;
  /** Distance inside which orders/positions can't be modified, in points. 0 = none. */
  readonly freezeLevel: number;
  readonly volumeMin: number;
  readonly volumeMax: number;
  readonly volumeStep: number;
}

export interface Quote {
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  /** Epoch ms of the tick. */
  readonly time: number;
}

export interface Position {
  readonly id: string;
  readonly symbol: string;
  readonly side: Side;
  readonly volume: number;
  readonly openPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  /** Floating P/L in account currency, as reported by the broker. */
  readonly profit: number;
  readonly magic: number;
  readonly comment?: string;
}

export type PendingType = "BUY_LIMIT" | "BUY_STOP" | "SELL_LIMIT" | "SELL_STOP";

export interface PendingOrder {
  readonly id: string;
  readonly symbol: string;
  readonly type: PendingType;
  readonly volume: number;
  readonly openPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly magic: number;
}

/** §1 */
export interface PositionFilter {
  readonly symbol: string;
  readonly side: "ALL" | Side;
  readonly magic?: number;
  readonly inProfitOnly?: boolean;
}

/** One broker call the plan will make. Every modify carries both levels (R2.7). */
export type PlanItem =
  | {
      readonly op: "modify";
      readonly positionId: string;
      readonly side: Side;
      readonly sl: Price | null;
      readonly tp: Price | null;
    }
  | { readonly op: "close"; readonly positionId: string; readonly side: Side; readonly volume: number }
  | { readonly op: "cancel"; readonly orderId: string };

export interface Skipped {
  readonly id: string;
  readonly reason: string;
}
