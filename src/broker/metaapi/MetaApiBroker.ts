/**
 * BrokerProvider over MetaApi (ADR-0002, ADR-0008).
 * - Reads come from the streaming terminal state (0 credits, ADR-0007). Not synchronized → BrokerError, never stale data.
 * - Every trade has our own timeout. A timeout on an entry is "ambiguous" (R6.5); on anything else "retryable".
 * - Modify always sends both levels as numbers: value, or 0 for none.
 * - SDK errors become TradeResults. Nothing throws out of a trade call.
 */
import type { PendingOrder, Position, Quote, SymbolSpec } from "@/domain/types";
import {
  BrokerError,
  type AccountInfo,
  type BrokerHealth,
  type BrokerProvider,
  type Levels,
  type MarketOrderReq,
  type PendingOrderReq,
  type TradeResult,
} from "../BrokerProvider";
import { classify, codeName, LOCAL_CODE, RETCODE, type BrokerOp } from "../retcodes";
import {
  metaApiAccount,
  metaApiOrder,
  metaApiPosition,
  metaApiPrice,
  metaApiSpec,
  parseList,
  parseOne,
  toTradeResult,
} from "../schemas";
import { AdapterTimeout, withTimeout } from "../timeout";
import type { MetaApiConnectionPort, TradeOptionsPort } from "./port";

export interface MetaApiBrokerOptions {
  /** Per trade call. The SDK's own default is 60 s, far too long mid-batch. */
  readonly tradeTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly now?: () => number;
}

export interface ConnectOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const NOT_CONNECTED_ERRORS = new Set(["NotConnectedError", "NotSynchronizedError", "NotAuthenticatedError"]);

function hasCode(e: unknown): e is { numericCode?: unknown; stringCode?: unknown } {
  return typeof e === "object" && e !== null && ("numericCode" in e || "stringCode" in e);
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "";
}

export class MetaApiBroker implements BrokerProvider {
  readonly name = "metaapi" as const;
  readonly #conn: MetaApiConnectionPort;
  readonly #tradeTimeoutMs: number;
  readonly #readTimeoutMs: number;
  readonly #now: () => number;

  constructor(conn: MetaApiConnectionPort, opts: MetaApiBrokerOptions = {}) {
    this.#conn = conn;
    this.#tradeTimeoutMs = opts.tradeTimeoutMs ?? 8_000;
    this.#readTimeoutMs = opts.readTimeoutMs ?? 5_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Connect with exponential backoff. The factory opens and synchronizes one SDK connection. */
  static async connect(
    factory: () => Promise<MetaApiConnectionPort>,
    opts: MetaApiBrokerOptions & ConnectOptions = {},
  ): Promise<MetaApiBroker> {
    const attempts = opts.attempts ?? 5;
    const base = opts.baseDelayMs ?? 1_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return new MetaApiBroker(await factory(), opts);
      } catch (e) {
        last = e;
        if (i < attempts - 1) await sleep(Math.min(base * 2 ** i, 30_000));
      }
    }
    throw new BrokerError(
      "NOT_CONNECTED",
      `MetaApi connection failed after ${String(attempts)} attempts: ${errorName(last) || "error"}`,
    );
  }

  health(): Promise<BrokerHealth> {
    const ts = this.#conn.terminalState;
    return Promise.resolve({
      connected: ts.connected,
      connectedToBroker: ts.connectedToBroker,
      synchronized: this.#conn.synchronized,
    });
  }

  getAccount(): Promise<AccountInfo> {
    return this.#read(() => parseOne(metaApiAccount, this.#conn.terminalState.accountInformation, "account"));
  }

  getPositions(): Promise<Position[]> {
    return this.#read(() => parseList(metaApiPosition, this.#conn.terminalState.positions, "positions"));
  }

  getOrders(): Promise<PendingOrder[]> {
    return this.#read(() =>
      parseList(metaApiOrder, this.#conn.terminalState.orders, "orders").filter(
        (o): o is PendingOrder => o !== null,
      ),
    );
  }

  getSymbolSpec(symbol: string): Promise<SymbolSpec> {
    return this.#read(() => {
      const raw = this.#conn.terminalState.specification(symbol);
      if (raw === undefined || raw === null) {
        throw new BrokerError("NOT_FOUND", `no specification for ${symbol}`);
      }
      return parseOne(metaApiSpec, raw, "spec");
    });
  }

  async getQuote(symbol: string): Promise<Quote> {
    this.#assertReady();
    const cached = this.#conn.terminalState.price(symbol);
    if (cached !== undefined && cached !== null) return parseOne(metaApiPrice, cached, "price");
    try {
      const raw = await withTimeout(
        this.#conn
          .subscribeToMarketData(symbol)
          .then(() => this.#conn.terminalState.waitForPrice(symbol, Math.ceil(this.#readTimeoutMs / 1000))),
        this.#readTimeoutMs,
      );
      if (raw === undefined || raw === null) throw new BrokerError("NOT_FOUND", `no price for ${symbol}`);
      return parseOne(metaApiPrice, raw, "price");
    } catch (e) {
      if (e instanceof BrokerError) throw e;
      if (e instanceof AdapterTimeout) {
        throw new BrokerError("TIMEOUT", `no price for ${symbol} within ${String(this.#readTimeoutMs)} ms`);
      }
      throw new BrokerError("UNKNOWN", `price for ${symbol} failed: ${errorName(e) || "error"}`);
    }
  }

  modifyPosition(positionId: string, levels: Levels): Promise<TradeResult> {
    // ADR-0008: both levels, always, as numbers. 0 = no level.
    return this.#trade("modify", () => this.#conn.modifyPosition(positionId, levels.sl ?? 0, levels.tp ?? 0));
  }

  closePosition(positionId: string): Promise<TradeResult> {
    return this.#trade("close", () => this.#conn.closePosition(positionId, {}));
  }

  cancelOrder(orderId: string): Promise<TradeResult> {
    return this.#trade("cancel", () => this.#conn.cancelOrder(orderId));
  }

  placeMarket(req: MarketOrderReq): Promise<TradeResult> {
    const sl = req.sl ?? undefined;
    const tp = req.tp ?? undefined;
    const options = tradeOptions(req);
    return this.#trade("market", () =>
      req.side === "BUY"
        ? this.#conn.createMarketBuyOrder(req.symbol, req.volume, sl, tp, options)
        : this.#conn.createMarketSellOrder(req.symbol, req.volume, sl, tp, options),
    );
  }

  placePending(req: PendingOrderReq): Promise<TradeResult> {
    const sl = req.sl ?? undefined;
    const tp = req.tp ?? undefined;
    const o = tradeOptions(req);
    const c = this.#conn;
    const send: Record<PendingOrderReq["type"], (() => Promise<unknown>) | null> = {
      BUY_LIMIT: () => c.createLimitBuyOrder(req.symbol, req.volume, req.openPrice, sl, tp, o),
      SELL_LIMIT: () => c.createLimitSellOrder(req.symbol, req.volume, req.openPrice, sl, tp, o),
      BUY_STOP: () => c.createStopBuyOrder(req.symbol, req.volume, req.openPrice, sl, tp, o),
      SELL_STOP: () => c.createStopSellOrder(req.symbol, req.volume, req.openPrice, sl, tp, o),
      BUY_STOP_LIMIT: null,
      SELL_STOP_LIMIT: null,
    };
    const call = send[req.type];
    if (call === null) {
      return Promise.resolve(
        this.#local("pending", RETCODE.INVALID, "stop-limit entries are not supported", 0),
      );
    }
    return this.#trade("pending", call);
  }

  close(): Promise<void> {
    return this.#conn.close();
  }

  // ---------- internals ----------

  #assertReady(): void {
    const ts = this.#conn.terminalState;
    if (!ts.connected || !this.#conn.synchronized) {
      throw new BrokerError("NOT_CONNECTED", "MetaApi stream is not connected and synchronized");
    }
  }

  #read<T>(fn: () => T): Promise<T> {
    try {
      this.#assertReady();
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async #trade(op: BrokerOp, send: () => Promise<unknown>): Promise<TradeResult> {
    const ts = this.#conn.terminalState;
    if (!ts.connected || !ts.connectedToBroker) {
      // Nothing was sent, so this is safe to retry even for entries.
      return this.#local(op, LOCAL_CODE.NOT_CONNECTED, "not connected to the broker", 0);
    }
    const start = this.#now();
    try {
      const raw = await withTimeout(send(), this.#tradeTimeoutMs);
      return toTradeResult(op, raw, this.#now() - start);
    } catch (e) {
      return this.#fromError(op, e, this.#now() - start);
    }
  }

  #fromError(op: BrokerOp, e: unknown, latencyMs: number): TradeResult {
    if (e instanceof AdapterTimeout || errorName(e) === "TimeoutError") {
      return this.#local(op, LOCAL_CODE.ADAPTER_TIMEOUT, "no answer in time: outcome unknown", latencyMs);
    }
    if (errorName(e) === "TooManyRequestsError") {
      const meta = (e as { metadata?: { recommendedRetryTime?: unknown } }).metadata;
      const at = meta?.recommendedRetryTime;
      const when = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : Number.NaN;
      const retryAfterMs = Number.isFinite(when) ? Math.max(0, when - this.#now()) : 1_000;
      return { ...this.#local(op, LOCAL_CODE.RATE_LIMITED, "MetaApi rate limit", latencyMs), retryAfterMs };
    }
    if (NOT_CONNECTED_ERRORS.has(errorName(e))) {
      return this.#local(op, LOCAL_CODE.NOT_CONNECTED, errorName(e), latencyMs);
    }
    if (hasCode(e)) {
      // SDK TradeError: { message, numericCode, stringCode }.
      return toTradeResult(
        op,
        {
          numericCode: e.numericCode,
          stringCode: e.stringCode,
          message: (e as { message?: unknown }).message,
        },
        latencyMs,
      );
    }
    return this.#local(op, LOCAL_CODE.UNKNOWN_ERROR, errorName(e) || "unknown error", latencyMs);
  }

  #local(op: BrokerOp, code: number, message: string, latencyMs: number): TradeResult {
    const cls = classify(code, op);
    return { op, ok: cls === "success", class: cls, code, stringCode: codeName(code), message, latencyMs };
  }
}

function tradeOptions(req: { magic: number; comment: string; clientId: string }): TradeOptionsPort {
  return { magic: req.magic, comment: req.comment, clientId: req.clientId };
}
