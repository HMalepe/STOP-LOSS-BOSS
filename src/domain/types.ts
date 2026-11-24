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
  /**
   * Value of one tick for 1.0 lot, in account currency, for a LOSING position (MetaApi price `lossTickValue`,
   * verified in metaapi.cloud-sdk@29.3.4). Absent when the feed didn't send it: risk is then not computed, never guessed.
   */
  readonly lossTickValue?: number;
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
  /** R6.5 reconciliation key set at entry (MetaApi clientId). */
  readonly clientId?: string;
}

export type PendingType =
  "BUY_LIMIT" | "BUY_STOP" | "BUY_STOP_LIMIT" | "SELL_LIMIT" | "SELL_STOP" | "SELL_STOP_LIMIT";

export interface PendingOrder {
  readonly id: string;
  readonly symbol: string;
  readonly type: PendingType;
  readonly volume: number;
  readonly openPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly magic: number;
  /** R6.5 reconciliation key set at entry (MetaApi clientId). */
  readonly clientId?: string;
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
      /** R7.1: the levels the preview saw. A retry/execute is skipped if the live position no longer matches. */
      readonly before: { readonly sl: Price | null; readonly tp: Price | null };
    }
  | {
      readonly op: "close";
      readonly positionId: string;
      readonly side: Side;
      /** Informational: close is by ticket. null if the broker sent a bad volume (R0.5). */
      readonly volume: number | null;
    }
  | { readonly op: "cancel"; readonly orderId: string };

export interface Skipped {
  readonly id: string;
  readonly reason: string;
}
