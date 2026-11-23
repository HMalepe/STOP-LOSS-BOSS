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
  type Reconciled,
  type TradeResult,
  type Lenient,
} from "../BrokerProvider";
import { reconcileFrom } from "../reconcile";
import { classify, codeName, LOCAL_CODE, RETCODE, type BrokerOp } from "../retcodes";
import {
  metaApiAccount,
  metaApiInFlight,
  metaApiOrder,
  metaApiPosition,
  metaApiPrice,
  metaApiSpec,
  parseList,
  parseOrdersForClose,
  parsePositionsForClose,
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
  /** Max time for one attempt (account lookup + connect + sync). */
  readonly attemptTimeoutMs?: number;
  /** Max time for the whole connect, across attempts. */
  readonly deadlineMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 0..1, for backoff jitter. */
  readonly random?: () => number;
}

/** Server said "not connected" after we sent: the request may or may not have run. Not the same as our precheck. */
const SERVER_NOT_CONNECTED_ERRORS = new Set([
  "NotConnectedError",
  "NotSynchronizedError",
  "NotAuthenticatedError",
]);
/** Retrying won't help: bad token, wrong account id, bad config. */
const FATAL_CONNECT_ERRORS = new Set([
  "UnauthorizedError",
  "NotFoundError",
  "ValidationError",
  "ForbiddenError",
]);

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

  /**
   * Connect with jittered exponential backoff, a per-attempt timeout and an overall deadline.
   * Fails fast on errors retrying can't fix. An attempt that times out but connects later is closed, not leaked.
   */
  static async connect(
    factory: () => Promise<MetaApiConnectionPort>,
    opts: MetaApiBrokerOptions & ConnectOptions = {},
  ): Promise<MetaApiBroker> {
    const attempts = opts.attempts ?? 5;
    const base = opts.baseDelayMs ?? 1_000;
    const attemptTimeoutMs = opts.attemptTimeoutMs ?? 60_000;
    const deadlineMs = opts.deadlineMs ?? 180_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = opts.random ?? Math.random;
    const now = opts.now ?? (() => Date.now());
    const started = now();
    let last: unknown;
    let tried = 0;
    for (let i = 0; i < attempts; i++) {
      tried += 1;
      const pending = factory();
      try {
        return new MetaApiBroker(await withTimeout(pending, attemptTimeoutMs), opts);
      } catch (e) {
        last = e;
        // A slow attempt may still connect: close it when it does, so it doesn't leak a websocket.
        if (e instanceof AdapterTimeout) pending.then((c) => c.close()).catch(() => undefined);
        if (FATAL_CONNECT_ERRORS.has(errorName(e))) break;
        if (i === attempts - 1) break;
        const delay = Math.round(Math.min(base * 2 ** i, 30_000) * (0.8 + 0.4 * random()));
        if (now() - started + delay > deadlineMs) break;
        await sleep(delay);
      }
    }
    throw new BrokerError(
      "NOT_CONNECTED",
      `MetaApi connection failed after ${String(tried)} attempt${tried === 1 ? "" : "s"}: ${errorName(last) || "error"}`,
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

  getPositionsForClose(): Promise<Lenient<Position>> {
    return this.#read(() => parsePositionsForClose(this.#conn.terminalState.positions));
  }

  getOrdersForClose(): Promise<Lenient<PendingOrder>> {
    return this.#read(() => parseOrdersForClose(this.#conn.terminalState.orders));
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

  /**
   * Close by ticket. After any failure, check the book: if the ticket is gone, it IS closed (R4.5), whatever the
   * code said (10013 "invalid", NotFound, a timeout that landed...). Only trusted when the stream is synchronized.
   */
  async closePosition(positionId: string): Promise<TradeResult> {
    const result = await this.#trade("close", () => this.#conn.closePosition(positionId));
    if (result.ok || !this.#conn.synchronized || this.#onBook(positionId)) return result;
    return {
      op: "close",
      ok: true,
      class: "success",
      code: RETCODE.POSITION_CLOSED,
      stringCode: codeName(RETCODE.POSITION_CLOSED),
      message: `already closed (not on the book; broker said ${result.stringCode})`,
      latencyMs: result.latencyMs,
    };
  }

  /** R6.5 / ADR-0009: where did each clientId end up? Includes market orders still in flight. */
  reconcile(clientIds: readonly string[]): Promise<ReadonlyMap<string, Reconciled>> {
    return this.#read(() => {
      const ts = this.#conn.terminalState;
      const positions = parseList(metaApiPosition, ts.positions, "positions");
      const rawOrders = Array.isArray(ts.orders) ? (ts.orders as unknown[]) : [];
      const orders = parseList(metaApiOrder, rawOrders, "orders").filter(
        (o): o is PendingOrder => o !== null,
      );
      const inFlight = new Set(
        parseList(metaApiInFlight, rawOrders, "orders").filter((c): c is string => c !== null),
      );
      return reconcileFrom(clientIds, positions, orders, inFlight);
    });
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

  /** Reads need the whole chain up: our socket, MetaApi's link to the broker, and a synchronized state. Else it may be stale. */
  #assertReady(): void {
    const ts = this.#conn.terminalState;
    if (!ts.connected || !ts.connectedToBroker || !this.#conn.synchronized) {
      throw new BrokerError(
        "NOT_CONNECTED",
        "MetaApi stream is not connected, linked to the broker and synchronized",
      );
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

  /** Lenient: just looks for the ticket, so odd data elsewhere can't hide it. */
  #onBook(positionId: string): boolean {
    const raw = this.#conn.terminalState.positions;
    return (
      Array.isArray(raw) &&
      raw.some(
        (p: unknown) =>
          typeof p === "object" && p !== null && String((p as { id?: unknown }).id) === positionId,
      )
    );
  }

  async #trade(op: BrokerOp, send: () => Promise<unknown>): Promise<TradeResult> {
    const ts = this.#conn.terminalState;
    // Close/cancel by ticket only need the broker link; a resync must not block the panic button.
    const needsSync = op !== "close" && op !== "cancel";
    if (!ts.connected || !ts.connectedToBroker || (needsSync && !this.#conn.synchronized)) {
      // Nothing was sent, so this is safe to retry even for entries.
      return this.#local(op, LOCAL_CODE.NOT_CONNECTED, "not connected to the broker", 0);
    }
    const start = this.#now();
    const work = send();
    // The real outcome, whenever it arrives. Never rejects. Also keeps a late rejection from going unhandled.
    const late = work.then(
      (raw) => toTradeResult(op, raw, this.#now() - start),
      (e: unknown) => this.#fromError(op, e, this.#now() - start),
    );
    try {
      const raw = await withTimeout(work, this.#tradeTimeoutMs);
      return toTradeResult(op, raw, this.#now() - start);
    } catch (e) {
      if (e instanceof AdapterTimeout) {
        // Zombie risk: the SDK may still send this after reconnecting. Hand the executor the real outcome to wait on.
        return {
          ...this.#local(
            op,
            LOCAL_CODE.ADAPTER_TIMEOUT,
            "no answer in time: outcome unknown",
            this.#now() - start,
          ),
          settled: late,
        };
      }
      return this.#fromError(op, e, this.#now() - start);
    }
  }

  #fromError(op: BrokerOp, e: unknown, latencyMs: number): TradeResult {
    if (errorName(e) === "TimeoutError") {
      // MetaApi's own timeout: it gave up waiting, but the terminal may have executed it.
      return this.#local(op, LOCAL_CODE.ADAPTER_TIMEOUT, "no answer in time: outcome unknown", latencyMs);
    }
    if (errorName(e) === "TooManyRequestsError") {
      const meta = (e as { metadata?: { recommendedRetryTime?: unknown } }).metadata;
      const at = meta?.recommendedRetryTime;
      const when = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : Number.NaN;
      const retryAfterMs = Number.isFinite(when) ? Math.max(0, when - this.#now()) : 1_000;
      return { ...this.#local(op, LOCAL_CODE.RATE_LIMITED, "MetaApi rate limit", latencyMs), retryAfterMs };
    }
    if (errorName(e) === "ValidationError") {
      // MetaApi rejected the request before sending it to the terminal.
      return this.#local(
        op,
        RETCODE.INVALID,
        `ValidationError: ${e instanceof Error ? e.message : ""}`,
        latencyMs,
      );
    }
    if (SERVER_NOT_CONNECTED_ERRORS.has(errorName(e))) {
      // Undocumented whether the request ran: unknown outcome (ambiguous for entries), unlike our own precheck.
      return this.#local(op, LOCAL_CODE.UNKNOWN_ERROR, errorName(e), latencyMs);
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
