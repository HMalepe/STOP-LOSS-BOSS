import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeSharedMetaApiBroker,
  MetaApiBroker,
  resetSharedMetaApiBroker,
  sharedMetaApiBroker,
  type MetaApiConnectionPort,
} from "@/broker/metaapi";
import { BrokerError } from "@/broker/BrokerProvider";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { AdapterTimeout, withTimeout } from "@/broker/timeout";

const never = () => new Promise<never>(() => undefined);
const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name }, extra);
const done = {
  numericCode: 10009,
  stringCode: "TRADE_RETCODE_DONE",
  message: "Request completed",
  orderId: "1",
  positionId: "1",
};

const rawPosition = {
  id: 11,
  type: "POSITION_TYPE_SELL",
  symbol: "EURUSD",
  magic: 5,
  openPrice: 1.087,
  stopLoss: 0,
  takeProfit: 1.08,
  volume: 0.1,
  profit: 3,
};
const rawSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 0,
  freezeLevel: 0,
  minVolume: 0.01,
  maxVolume: 100,
  volumeStep: 0.01,
};
const rawPrice = { symbol: "EURUSD", bid: 1.086, ask: 1.0861, time: new Date(42) };
const rawAccount = {
  currency: "USD",
  balance: 1000,
  equity: 1003,
  margin: 21,
  freeMargin: 982,
  marginLevel: 4776,
  leverage: 500,
  marginMode: "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING",
  type: "ACCOUNT_TRADE_MODE_DEMO",
  tradeAllowed: true,
};

function fake(over: Partial<{ connected: boolean; connectedToBroker: boolean; synchronized: boolean }> = {}) {
  const prices = new Map<string, unknown>([["EURUSD", rawPrice]]);
  const ts = {
    connected: over.connected ?? true,
    connectedToBroker: over.connectedToBroker ?? true,
    accountInformation: rawAccount as unknown,
    positions: [rawPosition] as unknown,
    orders: [
      { id: 21, type: "ORDER_TYPE_BUY_LIMIT", symbol: "EURUSD", openPrice: 1.08, volume: 0.1 },
      { id: 22, type: "ORDER_TYPE_BUY", symbol: "EURUSD", openPrice: 1.08, volume: 0.1 },
    ] as unknown,
    specification: vi.fn((s: string): unknown => (s === "EURUSD" ? rawSpec : undefined)),
    price: vi.fn((s: string): unknown => prices.get(s)),
    waitForPrice: vi.fn((): Promise<unknown> => Promise.resolve({ ...rawPrice, symbol: "GBPUSD" })),
  };
  const conn = {
    terminalState: ts,
    synchronized: over.synchronized ?? true,
    subscribeToMarketData: vi.fn((): Promise<unknown> => Promise.resolve()),
    calculateMargin: vi.fn((): Promise<unknown> => Promise.resolve({ margin: 217.22 })),
    modifyPosition: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    closePosition: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    cancelOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createMarketBuyOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createMarketSellOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createLimitBuyOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createLimitSellOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createStopBuyOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    createStopSellOrder: vi.fn((): Promise<unknown> => Promise.resolve(done)),
    close: vi.fn((): Promise<void> => Promise.resolve()),
  };
  return conn satisfies MetaApiConnectionPort;
}

const tag = { magic: 7731000000009, comment: "OD:x", clientId: "p1" };
const market = { ...tag, symbol: "EURUSD", side: "BUY" as const, volume: 0.1, sl: 1.08, tp: null };

afterEach(() => {
  vi.useRealTimers();
  resetSharedMetaApiBroker();
});

describe("R9.3 margin (calculateMargin)", () => {
  it("asks MetaApi with the SDK's order shape and returns the margin", async () => {
    const conn = fake();
    const b = new MetaApiBroker(conn);
    expect(await b.calculateMargin({ symbol: "EURUSD", side: "SELL", volume: 0.2, openPrice: 1.086 })).toBe(
      217.22,
    );
    expect(conn.calculateMargin).toHaveBeenCalledWith({
      symbol: "EURUSD",
      type: "ORDER_TYPE_SELL",
      volume: 0.2,
      openPrice: 1.086,
    });
  });

  it("no margin in the answer, a bad value, an SDK error or a timeout → null (the caller blocks, never estimates)", async () => {
    vi.useFakeTimers();
    for (const answer of [
      () => Promise.resolve({}),
      () => Promise.resolve({ margin: -1 }),
      () => Promise.resolve({ margin: "x" }),
      () => Promise.reject(new Error("boom")),
    ]) {
      const conn = fake();
      conn.calculateMargin.mockImplementation(answer);
      expect(
        await new MetaApiBroker(conn).calculateMargin({
          symbol: "EURUSD",
          side: "BUY",
          volume: 0.1,
          openPrice: 1,
        }),
      ).toBeNull();
    }
    const conn = fake();
    conn.calculateMargin.mockImplementation(() => new Promise(() => undefined));
    const p = new MetaApiBroker(conn, { readTimeoutMs: 50 }).calculateMargin({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1,
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toBeNull();
  });

  it("quotes carry lossTickValue when the stream sends it (R9.2)", async () => {
    const conn = fake();
    conn.terminalState.price.mockReturnValue({
      symbol: "EURUSD",
      bid: 1.086,
      ask: 1.0861,
      time: new Date(5),
      lossTickValue: 0.98,
    });
    expect(await new MetaApiBroker(conn).getQuote("EURUSD")).toMatchObject({ lossTickValue: 0.98 });
  });
});

describe("close-now reads (lenient)", () => {
  it("one unparseable position elsewhere fails getPositions but not getPositionsForClose", async () => {
    const conn = fake();
    conn.terminalState.positions = [rawPosition, { id: 99, type: "WEIRD", symbol: "GBPUSD" }];
    const b = new MetaApiBroker(conn);
    await expect(b.getPositions()).rejects.toThrow(BrokerError);
    const lenient = await b.getPositionsForClose();
    expect(lenient.items.map((p) => p.id)).toEqual(["11"]);
    expect(lenient.unreadable).toEqual([
      { id: "99", symbol: "GBPUSD", reason: expect.any(String) as unknown },
    ]);
    expect((await b.getOrdersForClose()).items.map((o) => o.id)).toEqual(["21"]);
  });
});

describe("reads from the stream", () => {
  it("health maps the terminal state", async () => {
    const b = new MetaApiBroker(fake({ connectedToBroker: false }));
    expect(await b.health()).toEqual({ connected: true, connectedToBroker: false, synchronized: true });
  });

  it("parses positions, orders (dropping non-pending), account and spec", async () => {
    const b = new MetaApiBroker(fake());
    expect(await b.getPositions()).toEqual([
      {
        id: "11",
        symbol: "EURUSD",
        side: "SELL",
        volume: 0.1,
        openPrice: 1.087,
        sl: null,
        tp: 1.08,
        profit: 3,
        magic: 5,
      },
    ]);
    expect((await b.getOrders()).map((o) => o.id)).toEqual(["21"]);
    expect((await b.getAccount()).marginMode).toBe("HEDGING");
    expect((await b.getSymbolSpec("EURUSD")).volumeMax).toBe(100);
    await expect(b.getSymbolSpec("XYZ")).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("never serves stale data: not connected or not synchronized → NOT_CONNECTED", async () => {
    await expect(new MetaApiBroker(fake({ synchronized: false })).getPositions()).rejects.toMatchObject({
      kind: "NOT_CONNECTED",
    });
    await expect(new MetaApiBroker(fake({ connected: false })).getQuote("EURUSD")).rejects.toMatchObject({
      kind: "NOT_CONNECTED",
    });
  });

  it("bad broker data fails loudly", async () => {
    const conn = fake();
    conn.terminalState.positions = [{ ...rawPosition, type: "??" }];
    await expect(new MetaApiBroker(conn).getPositions()).rejects.toMatchObject({ kind: "BAD_DATA" });
  });

  it("quote: cached price first; otherwise subscribe and wait", async () => {
    const conn = fake();
    const b = new MetaApiBroker(conn);
    expect(await b.getQuote("EURUSD")).toEqual({ symbol: "EURUSD", bid: 1.086, ask: 1.0861, time: 42 });
    expect(conn.subscribeToMarketData).not.toHaveBeenCalled();
    expect((await b.getQuote("GBPUSD")).symbol).toBe("GBPUSD");
    expect(conn.subscribeToMarketData).toHaveBeenCalledWith("GBPUSD");
  });

  it("quote failures are typed: timeout, missing, other", async () => {
    const slow = fake();
    slow.subscribeToMarketData.mockImplementation(never);
    await expect(new MetaApiBroker(slow, { readTimeoutMs: 10 }).getQuote("GBPUSD")).rejects.toMatchObject({
      kind: "TIMEOUT",
    });

    const missing = fake();
    missing.terminalState.waitForPrice.mockResolvedValue(undefined);
    await expect(new MetaApiBroker(missing).getQuote("GBPUSD")).rejects.toMatchObject({ kind: "NOT_FOUND" });

    const broken = fake();
    broken.subscribeToMarketData.mockRejectedValue(named("WeirdError"));
    await expect(new MetaApiBroker(broken).getQuote("GBPUSD")).rejects.toMatchObject({ kind: "UNKNOWN" });

    const anonymous = fake();
    anonymous.subscribeToMarketData.mockRejectedValue("boom");
    await expect(new MetaApiBroker(anonymous).getQuote("GBPUSD")).rejects.toThrow(/failed: error/);
  });
});

describe("trades: wire format (ADR-0008)", () => {
  it("modify always sends BOTH levels as numbers; null becomes 0", async () => {
    const conn = fake();
    const b = new MetaApiBroker(conn);
    expect((await b.modifyPosition("11", { sl: 1.0805, tp: null })).ok).toBe(true);
    expect(conn.modifyPosition).toHaveBeenCalledWith("11", 1.0805, 0);
    await b.modifyPosition("11", { sl: null, tp: 1.09 });
    expect(conn.modifyPosition).toHaveBeenLastCalledWith("11", 0, 1.09);
  });

  it("close and cancel by id", async () => {
    const conn = fake();
    const b = new MetaApiBroker(conn);
    expect((await b.closePosition("11")).op).toBe("close");
    expect(conn.closePosition).toHaveBeenCalledWith("11");
    expect((await b.cancelOrder("21")).op).toBe("cancel");
    expect(conn.cancelOrder).toHaveBeenCalledWith("21");
  });

  it("market entries pick the side's method and carry magic, comment and clientId", async () => {
    const conn = fake();
    const b = new MetaApiBroker(conn);
    const r = await b.placeMarket(market);
    expect(r).toMatchObject({ ok: true, positionId: "1" });
    expect(conn.createMarketBuyOrder).toHaveBeenCalledWith("EURUSD", 0.1, 1.08, undefined, tag);
    await b.placeMarket({ ...market, side: "SELL", sl: null, tp: 1.07 });
    expect(conn.createMarketSellOrder).toHaveBeenCalledWith("EURUSD", 0.1, undefined, 1.07, tag);
  });

  it.each([
    ["BUY_LIMIT", "createLimitBuyOrder"],
    ["SELL_LIMIT", "createLimitSellOrder"],
    ["BUY_STOP", "createStopBuyOrder"],
    ["SELL_STOP", "createStopSellOrder"],
  ] as const)("pending %s → %s", async (type, method) => {
    const conn = fake();
    await new MetaApiBroker(conn).placePending({
      ...tag,
      symbol: "EURUSD",
      type,
      volume: 0.1,
      openPrice: 1.08,
      sl: null,
      tp: 1.09,
    });
    expect(conn[method]).toHaveBeenCalledWith("EURUSD", 0.1, 1.08, undefined, 1.09, tag);
  });

  it("stop-limit entries are refused locally, nothing sent", async () => {
    const conn = fake();
    const r = await new MetaApiBroker(conn).placePending({
      ...tag,
      symbol: "EURUSD",
      type: "BUY_STOP_LIMIT",
      volume: 0.1,
      openPrice: 1.08,
      sl: null,
      tp: null,
    });
    expect(r).toMatchObject({
      ok: false,
      class: "final",
      code: RETCODE.INVALID,
      message: "stop-limit entries are not supported",
    });
  });
});

describe("trades: every failure is a result, never a throw", () => {
  it("not connected to the broker → NOT_CONNECTED, nothing sent (safe to retry even for entries)", async () => {
    const conn = fake({ connectedToBroker: false });
    const r = await new MetaApiBroker(conn).placeMarket(market);
    expect(r).toMatchObject({ code: LOCAL_CODE.NOT_CONNECTED, class: "retryable" });
    expect(conn.createMarketBuyOrder).not.toHaveBeenCalled();
  });

  it("R6.5: our timeout on an entry is ambiguous; on a modify it's retryable", async () => {
    const conn = fake();
    conn.createMarketBuyOrder.mockImplementation(never);
    conn.modifyPosition.mockImplementation(never);
    let t = 0;
    const b = new MetaApiBroker(conn, { tradeTimeoutMs: 15, now: () => (t += 100) });
    expect(await b.placeMarket(market)).toMatchObject({
      class: "ambiguous",
      code: LOCAL_CODE.ADAPTER_TIMEOUT,
      latencyMs: 100,
    });
    expect(await b.modifyPosition("11", { sl: 1, tp: null })).toMatchObject({
      class: "retryable",
      code: LOCAL_CODE.ADAPTER_TIMEOUT,
    });
  });

  it("the SDK's own TimeoutError is treated the same way", async () => {
    const conn = fake();
    conn.createMarketBuyOrder.mockRejectedValue(named("TimeoutError"));
    expect((await new MetaApiBroker(conn).placeMarket(market)).class).toBe("ambiguous");
  });

  it("TradeError keeps the broker's code and message", async () => {
    const conn = fake();
    conn.modifyPosition.mockRejectedValue(
      Object.assign(new Error("Invalid stops"), {
        name: "TradeError",
        numericCode: 10016,
        stringCode: "TRADE_RETCODE_INVALID_STOPS",
      }),
    );
    expect(await new MetaApiBroker(conn).modifyPosition("11", { sl: 1, tp: null })).toMatchObject({
      ok: false,
      class: "final",
      code: 10016,
      message: "Invalid stops",
    });
  });

  it("R6.2: TooManyRequestsError → RATE_LIMITED with retryAfterMs from recommendedRetryTime", async () => {
    const now = () => 1_000_000;
    const cases: [unknown, number][] = [
      [new Date(1_004_000), 4_000],
      [new Date(1_004_500).toISOString(), 4_500],
      [new Date(900_000), 0],
      [undefined, 1_000],
    ];
    for (const [recommendedRetryTime, expected] of cases) {
      const conn = fake();
      conn.closePosition.mockRejectedValue(
        named("TooManyRequestsError", { metadata: { recommendedRetryTime } }),
      );
      expect(await new MetaApiBroker(conn, { now }).closePosition("11")).toMatchObject({
        code: LOCAL_CODE.RATE_LIMITED,
        class: "retryable",
        retryAfterMs: expected,
      });
    }
  });

  it("server-side not-connected errors are UNKNOWN outcomes: ambiguous for entries (may have run)", async () => {
    const conn = fake();
    conn.cancelOrder.mockRejectedValue(named("NotSynchronizedError"));
    conn.createMarketBuyOrder.mockRejectedValue(named("NotConnectedError"));
    const b = new MetaApiBroker(conn);
    expect(await b.cancelOrder("21")).toMatchObject({ code: LOCAL_CODE.UNKNOWN_ERROR, class: "retryable" });
    expect(await b.placeMarket(market)).toMatchObject({ code: LOCAL_CODE.UNKNOWN_ERROR, class: "ambiguous" });
  });

  it("our precheck needs a synchronized stream too; nothing is sent otherwise", async () => {
    const conn = fake({ synchronized: false });
    expect(await new MetaApiBroker(conn).placeMarket(market)).toMatchObject({
      code: LOCAL_CODE.NOT_CONNECTED,
      class: "retryable",
    });
    expect(conn.createMarketBuyOrder).not.toHaveBeenCalled();
  });

  it("zombie guard: after our timeout, `settled` delivers the real late outcome", async () => {
    const conn = fake();
    let land: (v: unknown) => void = () => undefined;
    conn.createMarketBuyOrder.mockImplementation(() => new Promise((r) => (land = r)));
    const r = await new MetaApiBroker(conn, { tradeTimeoutMs: 10 }).placeMarket(market);
    expect(r).toMatchObject({ class: "ambiguous", code: LOCAL_CODE.ADAPTER_TIMEOUT });
    expect(r.settled).toBeInstanceOf(Promise);
    land(done);
    expect(await r.settled).toMatchObject({ ok: true, code: 10009, positionId: "1" });
  });

  it("zombie guard: a late failure settles as a result too (never rejects)", async () => {
    const conn = fake();
    let fail: (e: unknown) => void = () => undefined;
    conn.modifyPosition.mockImplementation(() => new Promise((_, rej) => (fail = rej)));
    const r = await new MetaApiBroker(conn, { tradeTimeoutMs: 10 }).modifyPosition("11", { sl: 1, tp: null });
    fail(
      Object.assign(new Error("Invalid stops"), {
        numericCode: 10016,
        stringCode: "TRADE_RETCODE_INVALID_STOPS",
      }),
    );
    expect(await r.settled).toMatchObject({ ok: false, code: 10016, class: "final" });
  });

  it("a normal answer carries no `settled`", async () => {
    expect(await new MetaApiBroker(fake()).closePosition("11")).not.toHaveProperty("settled");
  });

  it("anything else → UNKNOWN_ERROR: ambiguous for an entry, retryable for a close", async () => {
    const conn = fake();
    conn.createMarketBuyOrder.mockRejectedValue("socket exploded");
    conn.closePosition.mockRejectedValue(named("WeirdError"));
    const b = new MetaApiBroker(conn);
    expect(await b.placeMarket(market)).toMatchObject({
      code: LOCAL_CODE.UNKNOWN_ERROR,
      class: "ambiguous",
      message: "unknown error",
    });
    expect(await b.closePosition("11")).toMatchObject({
      code: LOCAL_CODE.UNKNOWN_ERROR,
      class: "retryable",
      message: "WeirdError",
    });
  });

  it("close() closes the connection", async () => {
    const conn = fake();
    await new MetaApiBroker(conn).close();
    expect(conn.close).toHaveBeenCalled();
  });
});

describe("connect with backoff, one connection per process", () => {
  it("retries with exponential backoff, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const factory = () =>
      ++calls < 3 ? Promise.reject(named("NotConnectedError")) : Promise.resolve(fake());
    const b = await MetaApiBroker.connect(factory, {
      baseDelayMs: 1000,
      random: () => 0.5,
      sleep: (ms) => (delays.push(ms), Promise.resolve()),
    });
    expect(b.name).toBe("metaapi");
    expect(delays).toEqual([1000, 2000]);
  });

  it("gives up after N attempts with a clear error, and caps the delay at 30 s", async () => {
    const delays: number[] = [];
    const factory = () => Promise.reject(named("NotAuthenticatedError"));
    await expect(
      MetaApiBroker.connect(factory, {
        attempts: 7,
        baseDelayMs: 1000,
        random: () => 0.5,
        deadlineMs: 10 * 60_000,
        sleep: (ms) => (delays.push(ms), Promise.resolve()),
      }),
    ).rejects.toMatchObject({
      kind: "NOT_CONNECTED",
      message: "MetaApi connection failed after 7 attempts: NotAuthenticatedError",
    });
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    await expect(MetaApiBroker.connect(() => Promise.reject(named("")), { attempts: 1 })).rejects.toThrow(
      /1 attempt: error/,
    );
  });

  it("the default sleep really waits", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = MetaApiBroker.connect(
      () => (++calls < 2 ? Promise.reject(new Error("x")) : Promise.resolve(fake())),
      { baseDelayMs: 50, random: () => 0.5 },
    );
    await vi.advanceTimersByTimeAsync(50);
    expect((await p).name).toBe("metaapi");
    vi.useRealTimers();
  });

  it("shares one connection; a failed connect is forgotten so the next call retries", async () => {
    const factory = vi.fn(() => Promise.resolve(fake()));
    const a = sharedMetaApiBroker(factory);
    const b = sharedMetaApiBroker(factory);
    expect(a).toBe(b);
    await a;
    expect(factory).toHaveBeenCalledTimes(1);

    resetSharedMetaApiBroker();
    const failing = vi.fn(() => Promise.reject(new Error("down")));
    await expect(sharedMetaApiBroker(failing, { attempts: 1 })).rejects.toThrow();
    expect((await sharedMetaApiBroker(factory)).name).toBe("metaapi");
  });
});

describe("withTimeout", () => {
  it("passes results through and rejects with AdapterTimeout when slow", async () => {
    expect(await withTimeout(Promise.resolve(5), 50)).toBe(5);
    await expect(withTimeout(never(), 5)).rejects.toBeInstanceOf(AdapterTimeout);
    await expect(withTimeout(never(), 5)).rejects.toThrow("no answer within 5 ms");
  });
});

describe("connect hardening (SRE review)", () => {
  it("fails fast on errors retrying can't fix (bad token, unknown account)", async () => {
    const factory = vi.fn(() => Promise.reject(named("UnauthorizedError")));
    await expect(MetaApiBroker.connect(factory, { sleep: () => Promise.resolve() })).rejects.toThrow(
      "after 1 attempt: UnauthorizedError",
    );
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a slow attempt times out, and if it connects later it is closed, not leaked", async () => {
    const late = fake();
    let resolveFirst: (c: MetaApiConnectionPort) => void = () => undefined;
    let calls = 0;
    const factory = () =>
      ++calls === 1 ? new Promise<MetaApiConnectionPort>((r) => (resolveFirst = r)) : Promise.resolve(fake());
    const b = await MetaApiBroker.connect(factory, { attemptTimeoutMs: 10, sleep: () => Promise.resolve() });
    expect(b.name).toBe("metaapi");
    resolveFirst(late);
    await new Promise((r) => setTimeout(r, 0));
    expect(late.close).toHaveBeenCalled();
  });

  it("stops retrying when the next wait would pass the overall deadline", async () => {
    let t = 0;
    const factory = vi.fn(() => {
      t += 50_000;
      return Promise.reject(named("NotConnectedError"));
    });
    await expect(
      MetaApiBroker.connect(factory, {
        attempts: 10,
        baseDelayMs: 20_000,
        deadlineMs: 120_000,
        now: () => t,
        random: () => 0.5,
        sleep: (ms) => ((t += ms), Promise.resolve()),
      }),
    ).rejects.toThrow(/after 2 attempts/);
  });

  it("jitters the backoff within ±20%", async () => {
    const delays: number[] = [];
    const run = (random: () => number) =>
      MetaApiBroker.connect(() => Promise.reject(named("X")), {
        attempts: 2,
        baseDelayMs: 1000,
        random,
        sleep: (ms) => (delays.push(ms), Promise.resolve()),
      }).catch(() => undefined);
    await run(() => 0);
    await run(() => 1);
    expect(delays).toEqual([800, 1200]);
  });
});

describe("watchdog and shutdown (SRE review)", () => {
  it("drops a connection unhealthy for longer than the limit; the next caller reconnects", async () => {
    vi.useFakeTimers();
    let t = 0;
    const first = fake();
    const second = fake();
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const drops: string[] = [];
    const opts = {
      watchdog: {
        intervalMs: 1_000,
        unhealthyForMs: 3_000,
        now: () => t,
        onDrop: (r: string) => drops.push(r),
      },
    };
    const a = await sharedMetaApiBroker(factory, opts);

    first.terminalState.connectedToBroker = false;
    for (let i = 0; i < 5; i++) {
      t += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(first.close).toHaveBeenCalled();
    expect(drops).toHaveLength(1);
    const b = await sharedMetaApiBroker(factory, opts);
    expect(b).not.toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a short blip doesn't drop the connection", async () => {
    vi.useFakeTimers();
    let t = 0;
    const conn = fake();
    await sharedMetaApiBroker(() => Promise.resolve(conn), {
      watchdog: { intervalMs: 1_000, unhealthyForMs: 3_000, now: () => t },
    });
    conn.terminalState.connected = false;
    t += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    conn.terminalState.connected = true;
    for (let i = 0; i < 5; i++) {
      t += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(conn.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("closeSharedMetaApiBroker closes the connection; safe with none open", async () => {
    const conn = fake();
    await sharedMetaApiBroker(() => Promise.resolve(conn), { watchdog: false });
    await closeSharedMetaApiBroker();
    expect(conn.close).toHaveBeenCalled();
    await expect(closeSharedMetaApiBroker()).resolves.toBeUndefined();
  });
});

describe("close-now hardening and reconcile (trading-systems review)", () => {
  it("a failed close whose ticket is gone from the book is 'already closed' = success", async () => {
    const conn = fake();
    conn.closePosition.mockRejectedValue(
      Object.assign(new Error("Invalid request"), {
        numericCode: 10013,
        stringCode: "TRADE_RETCODE_INVALID",
      }),
    );
    conn.terminalState.positions = [];
    expect(await new MetaApiBroker(conn).closePosition("11")).toMatchObject({
      ok: true,
      code: RETCODE.POSITION_CLOSED,
      message: "already closed (not on the book; broker said TRADE_RETCODE_INVALID)",
    });
  });

  it("a failed close whose ticket is still there stays a failure (retryable)", async () => {
    const conn = fake();
    conn.closePosition.mockRejectedValue(
      Object.assign(new Error("Rejected"), { numericCode: 10006, stringCode: "TRADE_RETCODE_REJECT" }),
    );
    expect(await new MetaApiBroker(conn).closePosition("11")).toMatchObject({
      ok: false,
      class: "retryable",
      code: 10006,
    });
  });

  it("the book check is skipped when the stream isn't synchronized (can't trust 'gone')", async () => {
    const conn = fake({ synchronized: false });
    conn.closePosition.mockRejectedValue(
      Object.assign(new Error("x"), { numericCode: 10006, stringCode: "TRADE_RETCODE_REJECT" }),
    );
    conn.terminalState.positions = [];
    expect((await new MetaApiBroker(conn).closePosition("11")).ok).toBe(false);
  });

  it("close and cancel don't wait for a resync; entries and modifies do", async () => {
    const conn = fake({ synchronized: false });
    const b = new MetaApiBroker(conn);
    expect((await b.cancelOrder("21")).ok).toBe(true);
    expect(conn.cancelOrder).toHaveBeenCalled();
    expect((await b.modifyPosition("11", { sl: 1, tp: null })).code).toBe(LOCAL_CODE.NOT_CONNECTED);
  });

  it("ValidationError means nothing was sent: INVALID, final for an entry", async () => {
    const conn = fake();
    conn.createMarketBuyOrder.mockRejectedValue(named("ValidationError"));
    expect(await new MetaApiBroker(conn).placeMarket(market)).toMatchObject({
      code: RETCODE.INVALID,
      class: "final",
    });
  });

  it("reconcile finds positions, pending orders and in-flight market orders by clientId", async () => {
    const conn = fake();
    conn.terminalState.positions = [{ ...rawPosition, clientId: "cP" }];
    conn.terminalState.orders = [
      {
        id: 21,
        type: "ORDER_TYPE_BUY_LIMIT",
        symbol: "EURUSD",
        openPrice: 1.08,
        volume: 0.1,
        clientId: "cO",
      },
      { id: 22, type: "ORDER_TYPE_BUY", symbol: "EURUSD", openPrice: 1.08, volume: 0.1, clientId: "cF" },
    ];
    const r = await new MetaApiBroker(conn).reconcile(["cP", "cO", "cF", "cX"]);
    expect([...r.entries()]).toEqual([
      ["cP", { status: "position", positionIds: ["11"] }],
      ["cO", { status: "order", orderIds: ["21"] }],
      ["cF", { status: "inFlight" }],
      ["cX", { status: "notFound" }],
    ]);
  });

  it("reconcile refuses a stale stream", async () => {
    await expect(new MetaApiBroker(fake({ synchronized: false })).reconcile(["x"])).rejects.toMatchObject({
      kind: "NOT_CONNECTED",
    });
  });
});
