/**
 * The only way the app talks to a broker (ADR-0002). Implementations: MockBroker, MetaApiBroker.
 *
 * Contract:
 * - Reads throw BrokerError when they can't return trustworthy data.
 * - Trade calls never throw: every outcome, including timeouts and SDK errors, is a TradeResult.
 * - modifyPosition always takes BOTH levels (ADR-0008). null = no level (sent as 0).
 * - All ids are strings.
 */
import type { PendingOrder, PendingType, Position, Quote, Side, SymbolSpec } from "@/domain/types";
import type { BrokerOp, TradeClass } from "./retcodes";

export type MarginMode = "HEDGING" | "NETTING" | "EXCHANGE";

/** What the broker says the account is. Checked against TRADING_MODE so a "demo" app can never drive a REAL account. */
export type AccountTradeMode = "DEMO" | "CONTEST" | "REAL";

export interface AccountInfo {
  readonly currency: string;
  readonly balance: number;
  readonly equity: number;
  readonly margin: number;
  readonly freeMargin: number;
  /** null when there is no margin in use. */
  readonly marginLevel: number | null;
  readonly leverage: number;
  readonly marginMode: MarginMode;
  readonly tradeMode: AccountTradeMode;
  readonly tradeAllowed: boolean;
}

export interface TradeResult {
  readonly op: BrokerOp;
  readonly ok: boolean;
  readonly class: TradeClass;
  /** MT5 retcode, or a negative LOCAL_CODE for failures that never reached MT5. */
  readonly code: number;
  readonly stringCode: string;
  readonly message: string;
  readonly latencyMs: number;
  readonly orderId?: string;
  readonly positionId?: string;
  /** R6.2: when rate limited, how long to wait before anyone sends again. */
  readonly retryAfterMs?: number;
  /**
   * Present only when OUR timeout fired while the request was still in flight ("zombie" risk): the SDK may still
   * send it later. Resolves (never rejects) with the real outcome once known. The executor must not retry or
   * reconcile this item until it settles (or a late deadline passes, after which the item is "unknown, check
   * manually", never retried). Not serialisable: strip before storing.
   */
  readonly settled?: Promise<TradeResult>;
}

export interface Levels {
  readonly sl: number | null;
  readonly tp: number | null;
}

export interface EntryTag {
  /** R9.1 batch identity. */
  readonly magic: number;
  readonly comment: string;
  /** R6.5 reconciliation key. comment + clientId ≤ 26 chars (MetaApi). */
  readonly clientId: string;
}

export interface MarketOrderReq extends Levels, EntryTag {
  readonly symbol: string;
  readonly side: Side;
  readonly volume: number;
}

export interface PendingOrderReq extends Levels, EntryTag {
  readonly symbol: string;
  readonly type: PendingType;
  readonly volume: number;
  readonly openPrice: number;
}

export interface BrokerHealth {
  /** Our connection to MetaApi (or the mock) is up. */
  readonly connected: boolean;
  /** MetaApi's terminal is connected to the broker server. */
  readonly connectedToBroker: boolean;
  /** Local state (positions, orders, specs) is fully synchronized. */
  readonly synchronized: boolean;
}

export type BrokerErrorKind =
  "NOT_CONNECTED" | "TIMEOUT" | "RATE_LIMITED" | "BAD_DATA" | "NOT_FOUND" | "UNKNOWN";

export class BrokerError extends Error {
  constructor(
    readonly kind: BrokerErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerProvider {
  readonly name: "mock" | "metaapi";
  health(): Promise<BrokerHealth>;
  getAccount(): Promise<AccountInfo>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<PendingOrder[]>;
  getQuote(symbol: string): Promise<Quote>;
  getSymbolSpec(symbol: string): Promise<SymbolSpec>;
  modifyPosition(positionId: string, levels: Levels): Promise<TradeResult>;
  closePosition(positionId: string): Promise<TradeResult>;
  placeMarket(req: MarketOrderReq): Promise<TradeResult>;
  placePending(req: PendingOrderReq): Promise<TradeResult>;
  cancelOrder(orderId: string): Promise<TradeResult>;
  close(): Promise<void>;
}
