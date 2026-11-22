/**
 * A simulated MT5 account behind BrokerProvider (06-TESTING "MockBroker requirements").
 *
 * It implements MT5's rules INDEPENDENTLY of src/domain: if the domain gets a rule wrong, the mock still rejects
 * the request with the real retcode and the test goes red. Re-using the domain here would let one bug hide another.
 *
 * Worst-case by default: re-checks preserved levels (R2.11), freezes on existing levels (R2.9), charges MetaApi credits.
 */
import type { Clock } from "@/domain/clock";
import type { PendingOrder, PendingType, Position, Quote, Side, SymbolSpec } from "@/domain/types";
import {
  BrokerError,
  type AccountInfo,
  type AccountTradeMode,
  type BrokerHealth,
  type BrokerProvider,
  type Levels,
  type MarginMode,
  type MarketOrderReq,
  type PendingOrderReq,
  type Reconciled,
  type TradeResult,
} from "./BrokerProvider";
import { reconcileFrom } from "./reconcile";
import { classify, codeName, LOCAL_CODE, RETCODE, type BrokerOp } from "./retcodes";

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Fault {
  /** Probability 0..1 per call. */
  readonly rate: number;
  readonly code: number;
}

export interface MockSymbol {
  readonly spec: SymbolSpec;
  readonly bid: number;
  readonly ask: number;
  /** Account-currency value of one tick for 1 lot. */
  readonly tickValue: number;
  readonly contractSize: number;
}

export interface MockBrokerOptions {
  readonly clock: Clock;
  readonly symbols: readonly MockSymbol[];
  readonly seed?: number;
  /** Lognormal latency fitted to p50/p99 (ms). Default 120 / 900 (06-TESTING). */
  readonly latency?: { readonly p50: number; readonly p99: number };
  /** Called with each sampled latency. Default: no real waiting (tests stay fast). Pass a real sleep for load runs. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly faults?: Partial<Record<BrokerOp, readonly Fault[]>>;
  /** Entries only: the order executes but the reply is lost (R6.5). */
  readonly lostReplyRate?: number;
  /** MetaApi credits (09-PERFORMANCE). null = no limit. */
  readonly rateLimit?: {
    readonly capacity: number;
    readonly windowMs: number;
    readonly costPerTrade: number;
  } | null;
  /** Worst case for R2.11: the server also checks the level you didn't change. */
  readonly recheckPreservedLevels?: boolean;
  readonly account?: {
    readonly balance: number;
    readonly currency: string;
    readonly leverage: number;
    readonly marginMode: MarginMode;
    readonly tradeMode?: AccountTradeMode;
  };
  readonly maxPositions?: number;
  readonly maxPendingOrders?: number;
}

export interface CallRecord {
  readonly index: number;
  readonly op: BrokerOp;
  readonly target: string;
  readonly args: unknown;
  readonly at: number;
  readonly result: TradeResult;
}

interface MutablePosition {
  id: string;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  magic: number;
  comment: string;
  clientId: string;
}

interface MutableOrder {
  id: string;
  symbol: string;
  type: PendingType;
  volume: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  magic: number;
  comment: string;
  clientId: string;
}

const DEFAULT_RATE = { capacity: 5000, windowMs: 10_000, costPerTrade: 10 } as const;

export class MockBroker implements BrokerProvider {
  readonly name = "mock" as const;
  readonly calls: CallRecord[] = [];

  readonly #opts: MockBrokerOptions;
  readonly #random: () => number;
  readonly #symbols = new Map<
    string,
    { spec: SymbolSpec; bid: number; ask: number; tickValue: number; contractSize: number }
  >();
  readonly #positions = new Map<string, MutablePosition>();
  readonly #orders = new Map<string, MutableOrder>();
  #balance: number;
  #nextTicket = 50_000_000;
  #connected = true;
  #windowStart: number;
  #creditsUsed = 0;
  #beforeCall: ((call: { index: number; op: BrokerOp; target: string }) => void) | undefined;
  readonly #inFlight = new Set<string>();

  constructor(opts: MockBrokerOptions) {
    this.#opts = opts;
    this.#random = seededRandom(opts.seed ?? 1);
    for (const s of opts.symbols) this.#symbols.set(s.spec.symbol, { ...s });
    this.#balance = opts.account?.balance ?? 10_000;
    this.#windowStart = opts.clock.now();
  }

  // ---------- test controls ----------

  setQuote(symbol: string, bid: number, ask: number): void {
    this.#symbol(symbol).bid = bid;
    this.#symbol(symbol).ask = ask;
  }

  setConnected(connected: boolean): void {
    this.#connected = connected;
  }

  /** Run something just before call N (e.g. close a position "by the broker" mid-batch). */
  onBeforeCall(hook: ((call: { index: number; op: BrokerOp; target: string }) => void) | undefined): void {
    this.#beforeCall = hook;
  }

  /** Put a position straight on the book (no validation, no call record). */
  seedPosition(
    p: Omit<Position, "profit" | "id"> & { readonly id?: string; readonly clientId?: string },
  ): string {
    const id = p.id ?? this.#ticket();
    this.#positions.set(id, {
      id,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      openPrice: p.openPrice,
      sl: p.sl,
      tp: p.tp,
      magic: p.magic,
      comment: p.comment ?? "",
      clientId: p.clientId ?? "",
    });
    return id;
  }

  seedOrder(o: Omit<PendingOrder, "id"> & { readonly id?: string }): string {
    const id = o.id ?? this.#ticket();
    this.#orders.set(id, { ...o, id, comment: "", clientId: "" });
    return id;
  }

  /** The broker closed it (SL hit, stop-out, manual close elsewhere). */
  closeExternally(positionId: string): void {
    this.#positions.delete(positionId);
  }

  // ---------- reads (free, like MetaApi terminalState) ----------

  health(): Promise<BrokerHealth> {
    return Promise.resolve({
      connected: this.#connected,
      connectedToBroker: this.#connected,
      synchronized: this.#connected,
    });
  }

  getAccount(): Promise<AccountInfo> {
    return this.#read(() => {
      const equity = this.#balance + this.#totalProfit();
      const margin = this.#usedMargin();
      return {
        currency: this.#opts.account?.currency ?? "USD",
        balance: this.#balance,
        equity,
        margin,
        freeMargin: equity - margin,
        marginLevel: margin === 0 ? null : (equity / margin) * 100,
        leverage: this.#leverage(),
        marginMode: this.#opts.account?.marginMode ?? "HEDGING",
        tradeMode: this.#opts.account?.tradeMode ?? "DEMO",
        tradeAllowed: true,
      };
    });
  }

  getPositions(): Promise<Position[]> {
    return this.#read(() =>
      [...this.#positions.values()].map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        volume: p.volume,
        openPrice: p.openPrice,
        sl: p.sl,
        tp: p.tp,
        profit: this.#profit(p),
        magic: p.magic,
        ...(p.comment === "" ? {} : { comment: p.comment }),
        ...(p.clientId === "" ? {} : { clientId: p.clientId }),
      })),
    );
  }

  getOrders(): Promise<PendingOrder[]> {
    return this.#read(() =>
      [...this.#orders.values()].map((o) => ({
        id: o.id,
        symbol: o.symbol,
        type: o.type,
        volume: o.volume,
        openPrice: o.openPrice,
        sl: o.sl,
        tp: o.tp,
        magic: o.magic,
        ...(o.clientId === "" ? {} : { clientId: o.clientId }),
      })),
    );
  }

  getQuote(symbol: string): Promise<Quote> {
    return this.#read(() => {
      const s = this.#symbol(symbol);
      return { symbol, bid: s.bid, ask: s.ask, time: this.#opts.clock.now() };
    });
  }

  getSymbolSpec(symbol: string): Promise<SymbolSpec> {
    return this.#read(() => this.#symbol(symbol).spec);
  }

  // ---------- trades ----------

  modifyPosition(positionId: string, levels: Levels): Promise<TradeResult> {
    return this.#trade("modify", positionId, levels, () => {
      const p = this.#positions.get(positionId);
      if (p === undefined) return RETCODE.POSITION_CLOSED;
      const s = this.#symbol(p.symbol);
      const closing = p.side === "BUY" ? s.bid : s.ask;
      // Freeze applies to the levels the position has right now (R2.9).
      if (this.#withinFreeze(p.sl, closing, s.spec) || this.#withinFreeze(p.tp, closing, s.spec)) {
        return RETCODE.FROZEN;
      }
      const slChanged = !this.#same(levels.sl, p.sl, s.spec);
      const tpChanged = !this.#same(levels.tp, p.tp, s.spec);
      if (!slChanged && !tpChanged) return RETCODE.NO_CHANGES;
      const recheck = this.#opts.recheckPreservedLevels ?? true;
      if ((slChanged || recheck) && !this.#stopOk(p.side, "SL", levels.sl, closing, s.spec)) {
        return RETCODE.INVALID_STOPS;
      }
      if ((tpChanged || recheck) && !this.#stopOk(p.side, "TP", levels.tp, closing, s.spec)) {
        return RETCODE.INVALID_STOPS;
      }
      // Exactly what was sent. null/0 = no level (ADR-0008).
      p.sl = levels.sl;
      p.tp = levels.tp;
      return RETCODE.DONE;
    });
  }

  closePosition(positionId: string): Promise<TradeResult> {
    return this.#trade("close", positionId, null, () => {
      const p = this.#positions.get(positionId);
      if (p === undefined) return RETCODE.POSITION_CLOSED;
      // MT5 also refuses to close while an existing SL/TP is within the freeze level (it's about to trigger).
      const s = this.#symbol(p.symbol);
      const closing = p.side === "BUY" ? s.bid : s.ask;
      if (this.#withinFreeze(p.sl, closing, s.spec) || this.#withinFreeze(p.tp, closing, s.spec)) {
        return RETCODE.FROZEN;
      }
      this.#balance += this.#profit(p);
      this.#positions.delete(positionId);
      return RETCODE.DONE;
    });
  }

  cancelOrder(orderId: string): Promise<TradeResult> {
    return this.#trade("cancel", orderId, null, () => {
      const o = this.#orders.get(orderId);
      if (o === undefined) return RETCODE.INVALID_ORDER;
      // A pending order whose price is within the freeze level of the market can't be cancelled.
      const s = this.#symbol(o.symbol);
      const market = o.type.startsWith("BUY_") ? s.ask : s.bid;
      if (this.#withinFreeze(o.openPrice, market, s.spec)) return RETCODE.FROZEN;
      this.#orders.delete(orderId);
      return RETCODE.DONE;
    });
  }

  placeMarket(req: MarketOrderReq): Promise<TradeResult> {
    let ticket: string | undefined;
    return this.#trade(
      "market",
      req.clientId,
      req,
      () => {
        const s = this.#symbols.get(req.symbol);
        if (s === undefined) return RETCODE.INVALID;
        const bad = this.#entryProblem(req, s.spec);
        if (bad !== null) return bad;
        const fill = req.side === "BUY" ? s.ask : s.bid;
        const closing = req.side === "BUY" ? s.bid : s.ask;
        if (!this.#stopOk(req.side, "SL", req.sl, closing, s.spec)) return RETCODE.INVALID_STOPS;
        if (!this.#stopOk(req.side, "TP", req.tp, closing, s.spec)) return RETCODE.INVALID_STOPS;
        if (this.#opts.maxPositions !== undefined && this.#positions.size >= this.#opts.maxPositions) {
          return RETCODE.LIMIT_ORDERS;
        }
        const required = (req.volume * s.contractSize * fill) / this.#leverage();
        if (required > this.#balance + this.#totalProfit() - this.#usedMargin()) return RETCODE.NO_MONEY;
        ticket = this.#ticket();
        this.#positions.set(ticket, {
          id: ticket,
          symbol: req.symbol,
          side: req.side,
          volume: req.volume,
          openPrice: fill,
          sl: req.sl,
          tp: req.tp,
          magic: req.magic,
          comment: req.comment,
          clientId: req.clientId,
        });
        return RETCODE.DONE;
      },
      () => (ticket === undefined ? {} : { orderId: ticket, positionId: ticket }),
    );
  }

  placePending(req: PendingOrderReq): Promise<TradeResult> {
    let ticket: string | undefined;
    return this.#trade(
      "pending",
      req.clientId,
      req,
      () => {
        const s = this.#symbols.get(req.symbol);
        if (s === undefined) return RETCODE.INVALID;
        const bad = this.#entryProblem(req, s.spec);
        if (bad !== null) return bad;
        const pts = (n: number) => Math.round(n / s.spec.point);
        const minGap = s.spec.stopsLevel;
        // A stop-limit's openPrice is its stop trigger, so it sits on the same side as a stop order.
        const valid =
          req.type === "BUY_LIMIT"
            ? pts(s.ask) - pts(req.openPrice) > minGap
            : req.type === "BUY_STOP" || req.type === "BUY_STOP_LIMIT"
              ? pts(req.openPrice) - pts(s.ask) > minGap
              : req.type === "SELL_LIMIT"
                ? pts(req.openPrice) - pts(s.bid) > minGap
                : pts(s.bid) - pts(req.openPrice) > minGap;
        if (!valid) return RETCODE.INVALID_PRICE;
        const side: Side = req.type.startsWith("BUY_") ? "BUY" : "SELL";
        if (!this.#stopOk(side, "SL", req.sl, req.openPrice, s.spec)) return RETCODE.INVALID_STOPS;
        if (!this.#stopOk(side, "TP", req.tp, req.openPrice, s.spec)) return RETCODE.INVALID_STOPS;
        if (this.#opts.maxPendingOrders !== undefined && this.#orders.size >= this.#opts.maxPendingOrders) {
          return RETCODE.LIMIT_ORDERS;
        }
        ticket = this.#ticket();
        this.#orders.set(ticket, { ...req, id: ticket });
        return RETCODE.PLACED;
      },
      () => (ticket === undefined ? {} : { orderId: ticket }),
    );
  }

  async reconcile(clientIds: readonly string[]): Promise<ReadonlyMap<string, Reconciled>> {
    const [positions, orders] = await Promise.all([this.getPositions(), this.getOrders()]);
    return reconcileFrom(clientIds, positions, orders, this.#inFlight);
  }

  /** Test control: pretend a market order with this clientId is still being processed. */
  setInFlight(clientId: string, inFlight: boolean): void {
    if (inFlight) this.#inFlight.add(clientId);
    else this.#inFlight.delete(clientId);
  }

  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  // ---------- internals ----------

  async #trade(
    op: BrokerOp,
    target: string,
    args: unknown,
    apply: () => number,
    ids: () => { orderId?: string; positionId?: string } = () => ({}),
  ): Promise<TradeResult> {
    const index = this.calls.length;
    this.#beforeCall?.({ index, op, target });
    const latencyMs = this.#sampleLatency();
    await (this.#opts.sleep ?? (() => Promise.resolve()))(latencyMs);

    const finish = (code: number, extra: Partial<TradeResult> = {}): TradeResult => {
      const cls = classify(code, op);
      const result: TradeResult = {
        op,
        ok: cls === "success",
        class: cls,
        code,
        stringCode: codeName(code),
        message: "",
        latencyMs,
        ...extra,
      };
      this.calls.push({ index, op, target, args, at: this.#opts.clock.now(), result });
      return result;
    };

    if (!this.#connected) return finish(LOCAL_CODE.NOT_CONNECTED);

    const limited = this.#chargeCredits();
    if (limited !== null) return finish(LOCAL_CODE.RATE_LIMITED, { retryAfterMs: limited });

    for (const fault of this.#opts.faults?.[op] ?? []) {
      if (this.#random() < fault.rate) return finish(fault.code);
    }

    const code = apply();
    const isEntry = op === "market" || op === "pending";
    if (isEntry && classify(code, op) === "success" && this.#random() < (this.#opts.lostReplyRate ?? 0)) {
      // It happened at the broker, but we never heard back in time. The real outcome arrives later (zombie model).
      const real: TradeResult = {
        op,
        ok: true,
        class: "success",
        code,
        stringCode: codeName(code),
        message: "",
        latencyMs,
        ...ids(),
      };
      return finish(LOCAL_CODE.ADAPTER_TIMEOUT, { settled: Promise.resolve(real) });
    }
    return finish(code, ids());
  }

  /** null = allowed; otherwise ms until the window resets. */
  #chargeCredits(): number | null {
    const limit = this.#opts.rateLimit === undefined ? DEFAULT_RATE : this.#opts.rateLimit;
    if (limit === null) return null;
    const now = this.#opts.clock.now();
    if (now - this.#windowStart >= limit.windowMs) {
      this.#windowStart = now;
      this.#creditsUsed = 0;
    }
    if (this.#creditsUsed + limit.costPerTrade > limit.capacity) {
      return this.#windowStart + limit.windowMs - now;
    }
    this.#creditsUsed += limit.costPerTrade;
    return null;
  }

  #entryProblem(req: { volume: number; comment: string; clientId: string }, spec: SymbolSpec): number | null {
    if (req.comment.length + req.clientId.length > 26) return RETCODE.INVALID;
    const steps = req.volume / spec.volumeStep;
    if (
      req.volume < spec.volumeMin ||
      req.volume > spec.volumeMax ||
      Math.abs(steps - Math.round(steps)) > 1e-7
    ) {
      return RETCODE.INVALID_VOLUME;
    }
    return null;
  }

  /** MT5 stops check, written independently of src/domain: distance from the closing price must exceed stopsLevel. */
  #stopOk(side: Side, kind: "SL" | "TP", value: number | null, closing: number, spec: SymbolSpec): boolean {
    if (value === null || value === 0) return true;
    if (!(value > 0)) return false;
    const dist = Math.round((value - closing) / spec.point);
    const belowWanted = side === "BUY" ? kind === "SL" : kind === "TP";
    return belowWanted ? -dist > spec.stopsLevel : dist > spec.stopsLevel;
  }

  #withinFreeze(level: number | null, closing: number, spec: SymbolSpec): boolean {
    if (level === null || spec.freezeLevel === 0) return false;
    return Math.abs(Math.round((level - closing) / spec.point)) <= spec.freezeLevel;
  }

  #same(a: number | null, b: number | null, spec: SymbolSpec): boolean {
    const norm = (x: number | null) => (x === null || x === 0 ? 0 : Math.round(x / spec.point));
    return norm(a) === norm(b);
  }

  #profit(p: MutablePosition): number {
    const s = this.#symbol(p.symbol);
    const exit = p.side === "BUY" ? s.bid : s.ask;
    const move = p.side === "BUY" ? exit - p.openPrice : p.openPrice - exit;
    return Math.round((move / s.spec.tickSize) * s.tickValue * p.volume * 100) / 100;
  }

  #totalProfit(): number {
    let sum = 0;
    for (const p of this.#positions.values()) sum += this.#profit(p);
    return sum;
  }

  #usedMargin(): number {
    let sum = 0;
    for (const p of this.#positions.values()) {
      const s = this.#symbol(p.symbol);
      sum += (p.volume * s.contractSize * p.openPrice) / this.#leverage();
    }
    return Math.round(sum * 100) / 100;
  }

  #leverage(): number {
    return this.#opts.account?.leverage ?? 500;
  }

  #sampleLatency(): number {
    const { p50, p99 } = this.#opts.latency ?? { p50: 120, p99: 900 };
    const sigma = Math.max(0, (Math.log(p99) - Math.log(p50)) / 2.326);
    // Box-Muller from two seeded uniforms.
    const u1 = Math.max(this.#random(), 1e-12);
    const u2 = this.#random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.round(Math.exp(Math.log(p50) + sigma * z));
  }

  #read<T>(fn: () => T): Promise<T> {
    if (!this.#connected) {
      return Promise.reject(new BrokerError("NOT_CONNECTED", "mock broker is disconnected"));
    }
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  #symbol(symbol: string) {
    const s = this.#symbols.get(symbol);
    if (s === undefined) throw new BrokerError("NOT_FOUND", `unknown symbol ${symbol}`);
    return s;
  }

  #ticket(): string {
    this.#nextTicket += 1;
    return String(this.#nextTicket);
  }
}
