import { describe, expect, it } from "vitest";
import { MockBroker, seededRandom, type MockBrokerOptions } from "@/broker/MockBroker";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { ManualClock } from "@/domain/clock";
import type { SymbolSpec } from "@/domain/types";

// EURUSD: bid 1.08600, ask 1.08610. stopsLevel 10, freezeLevel 5.
const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 10,
  freezeLevel: 5,
  volumeMin: 0.01,
  volumeMax: 50,
  volumeStep: 0.01,
};

function broker(over: Partial<MockBrokerOptions> = {}) {
  const clock = new ManualClock(1_763_769_600_000);
  const b = new MockBroker({
    clock,
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    rateLimit: null,
    ...over,
  });
  return { b, clock };
}

const tag = { magic: 7731000000001, comment: "OD:abc", clientId: "pl1x0" };
const seedBuy = (b: MockBroker, over: { sl?: number | null; tp?: number | null; openPrice?: number } = {}) =>
  b.seedPosition({
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    openPrice: over.openPrice ?? 1.085,
    sl: over.sl ?? null,
    tp: over.tp ?? null,
    magic: 0,
  });

describe("determinism", () => {
  it("the PRNG is seeded", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("same seed → same latencies and faults", async () => {
    const run = async () => {
      const { b } = broker({ seed: 7, faults: { close: [{ rate: 0.3, code: RETCODE.REQUOTE }] } });
      const out = [];
      for (let i = 0; i < 20; i++) out.push(await b.closePosition(seedBuy(b)));
      return out.map((r) => [r.code, r.latencyMs]);
    };
    expect(await run()).toEqual(await run());
  });

  it("latency median ≈ p50 and the tail reaches toward p99 (lognormal)", async () => {
    const { b } = broker({ latency: { p50: 120, p99: 900 } });
    const lat: number[] = [];
    for (let i = 0; i < 2000; i++) lat.push((await b.cancelOrder("none")).latencyMs);
    lat.sort((x, y) => x - y);
    expect(lat[1000]).toBeGreaterThan(100);
    expect(lat[1000]).toBeLessThan(140);
    expect(lat[1980]).toBeGreaterThan(500);
  });

  it("uses the injected sleep with the sampled latency", async () => {
    const slept: number[] = [];
    const { b } = broker({ sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    const r = await b.cancelOrder("x");
    expect(slept).toEqual([r.latencyMs]);
  });
});

describe("modify (independent MT5 model)", () => {
  it("sets exactly the levels sent; null removes a level (ADR-0008)", async () => {
    const { b } = broker();
    const id = seedBuy(b, { sl: 1.08, tp: 1.09 });
    const r = await b.modifyPosition(id, { sl: 1.0805, tp: null });
    expect(r).toMatchObject({ ok: true, code: RETCODE.DONE, class: "success" });
    expect((await b.getPositions())[0]).toMatchObject({ sl: 1.0805, tp: null });
  });

  it("invalid stops → 10016 final (buy SL must be below bid − stopsLevel)", async () => {
    const { b } = broker();
    const id = seedBuy(b);
    expect(await b.modifyPosition(id, { sl: 1.0859, tp: null })).toMatchObject({
      ok: false,
      code: 10016,
      class: "final",
    });
    expect((await b.modifyPosition(id, { sl: 1.08589, tp: null })).code).toBe(RETCODE.DONE);
  });

  it("sell SL is measured from ask", async () => {
    const { b } = broker();
    const id = b.seedPosition({
      symbol: "EURUSD",
      side: "SELL",
      volume: 0.1,
      openPrice: 1.087,
      sl: null,
      tp: null,
      magic: 0,
    });
    expect((await b.modifyPosition(id, { sl: 1.0862, tp: null })).code).toBe(RETCODE.INVALID_STOPS);
    expect((await b.modifyPosition(id, { sl: 1.08621, tp: null })).code).toBe(RETCODE.DONE);
  });

  it("frozen: an existing level within the freeze level → 10029", async () => {
    const { b } = broker();
    const id = seedBuy(b, { tp: 1.08605 });
    expect(await b.modifyPosition(id, { sl: 1.08, tp: 1.08605 })).toMatchObject({
      code: RETCODE.FROZEN,
      class: "final",
    });
  });

  it("nothing changes → 10025, which is success", async () => {
    const { b } = broker();
    const id = seedBuy(b, { sl: 1.08 });
    expect(await b.modifyPosition(id, { sl: 1.08, tp: null })).toMatchObject({
      ok: true,
      code: RETCODE.NO_CHANGES,
    });
  });

  it("R2.11 worst case: a preserved level inside stopsLevel is re-checked by default", async () => {
    const strict = broker();
    const id = seedBuy(strict.b, { tp: 1.08608 }); // 8 points above bid: inside stopsLevel 10, outside freeze 5
    expect((await strict.b.modifyPosition(id, { sl: 1.08, tp: 1.08608 })).code).toBe(RETCODE.INVALID_STOPS);
    const lenient = broker({ recheckPreservedLevels: false });
    const id2 = seedBuy(lenient.b, { tp: 1.08608 });
    expect((await lenient.b.modifyPosition(id2, { sl: 1.08, tp: 1.08608 })).code).toBe(RETCODE.DONE);
  });

  it("unknown position → 10036, final for modify", async () => {
    const { b } = broker();
    expect(await b.modifyPosition("nope", { sl: 1.08, tp: null })).toMatchObject({
      code: 10036,
      class: "final",
    });
  });

  it("a negative level is rejected", async () => {
    const { b } = broker();
    expect((await b.modifyPosition(seedBuy(b), { sl: -1, tp: null })).code).toBe(RETCODE.INVALID_STOPS);
  });
});

describe("close and cancel", () => {
  it("close books the P/L into the balance", async () => {
    const { b } = broker();
    const id = seedBuy(b); // +100 points × $1 × 0.1 lot = $10
    expect((await b.getPositions())[0]?.profit).toBe(10);
    expect((await b.closePosition(id)).ok).toBe(true);
    expect((await b.getAccount()).balance).toBe(10_010);
    expect(await b.getPositions()).toEqual([]);
  });

  it("R4.5: closing an already-closed position → 10036 success", async () => {
    const { b } = broker();
    expect(await b.closePosition("gone")).toMatchObject({ ok: true, code: 10036, class: "success" });
  });

  it("a position closed by the broker mid-batch (onBeforeCall hook)", async () => {
    const { b } = broker();
    const ids = [seedBuy(b), seedBuy(b), seedBuy(b)];
    b.onBeforeCall(({ index }) => {
      if (index === 1) b.closeExternally(ids[1]!);
    });
    const results = [];
    for (const id of ids) results.push(await b.closePosition(id));
    expect(results.map((r) => r.code)).toEqual([RETCODE.DONE, RETCODE.POSITION_CLOSED, RETCODE.DONE]);
    expect(results.every((r) => r.ok)).toBe(true);
    b.onBeforeCall(undefined);
  });

  it("cancel: done, then 10035 for an unknown order", async () => {
    const { b } = broker();
    const id = b.seedOrder({
      symbol: "EURUSD",
      type: "BUY_LIMIT",
      volume: 0.1,
      openPrice: 1.08,
      sl: null,
      tp: null,
      magic: 0,
    });
    expect((await b.cancelOrder(id)).ok).toBe(true);
    expect(await b.cancelOrder(id)).toMatchObject({ ok: false, code: RETCODE.INVALID_ORDER, class: "final" });
  });
});

describe("market entries", () => {
  const buy = { ...tag, symbol: "EURUSD", side: "BUY" as const, volume: 0.1, sl: 1.08, tp: 1.09 };

  it("fills a buy at ask with its stop, magic, comment and clientId", async () => {
    const { b } = broker();
    const r = await b.placeMarket(buy);
    expect(r).toMatchObject({ ok: true, code: RETCODE.DONE });
    expect(r.positionId).toBeDefined();
    const [p] = await b.getPositions();
    expect(p).toMatchObject({ openPrice: 1.0861, sl: 1.08, tp: 1.09, magic: tag.magic, comment: "OD:abc" });
    expect(b.positionsByClientId("pl1x0")).toEqual([r.positionId]);
  });

  it("validates the stop against the closing side: sell SL vs ask", async () => {
    const { b } = broker();
    const sell = { ...buy, side: "SELL" as const, sl: 1.0862, tp: 1.08 };
    expect((await b.placeMarket(sell)).code).toBe(RETCODE.INVALID_STOPS);
    expect(await b.getPositions()).toEqual([]);
  });

  it.each([
    [{ volume: 0.005 }, RETCODE.INVALID_VOLUME],
    [{ volume: 0.015 }, RETCODE.INVALID_VOLUME],
    [{ volume: 51 }, RETCODE.INVALID_VOLUME],
    [{ comment: "OD:a-really-long-comment", clientId: "pl1x0000" }, RETCODE.INVALID],
    [{ symbol: "XYZ" }, RETCODE.INVALID],
    [{ volume: 49 }, RETCODE.NO_MONEY],
  ])("rejects %o with %i", async (patch, code) => {
    const { b } = broker();
    expect((await b.placeMarket({ ...buy, ...patch })).code).toBe(code);
  });

  it("broker position cap → 10033", async () => {
    const { b } = broker({ maxPositions: 1 });
    expect((await b.placeMarket(buy)).ok).toBe(true);
    expect((await b.placeMarket(buy)).code).toBe(RETCODE.LIMIT_ORDERS);
  });

  it("R6.5: lost reply → ambiguous result, but the position IS on the book", async () => {
    const { b } = broker({ lostReplyRate: 1 });
    const r = await b.placeMarket(buy);
    expect(r).toMatchObject({ ok: false, class: "ambiguous", code: LOCAL_CODE.ADAPTER_TIMEOUT });
    expect(b.positionsByClientId("pl1x0")).toHaveLength(1);
  });

  it("lost replies only hit entries that would have succeeded", async () => {
    const { b } = broker({ lostReplyRate: 1 });
    expect((await b.placeMarket({ ...buy, volume: 0.005 })).code).toBe(RETCODE.INVALID_VOLUME);
    expect((await b.closePosition(seedBuy(b))).code).toBe(RETCODE.DONE);
  });
});

describe("pending entries", () => {
  const order = { ...tag, symbol: "EURUSD", volume: 0.1, sl: null, tp: null };

  it.each([
    ["BUY_LIMIT", 1.085, true],
    ["BUY_LIMIT", 1.0861, false],
    ["BUY_STOP", 1.087, true],
    ["BUY_STOP", 1.0861, false],
    ["SELL_LIMIT", 1.087, true],
    ["SELL_LIMIT", 1.086, false],
    ["SELL_STOP", 1.085, true],
    ["SELL_STOP", 1.086, false],
    ["BUY_STOP_LIMIT", 1.085, true],
    ["SELL_STOP_LIMIT", 1.087, true],
  ] as const)("%s at %d → ok=%s", async (type, openPrice, ok) => {
    const { b } = broker();
    const r = await b.placePending({ ...order, type, openPrice });
    expect(r.ok).toBe(ok);
    if (ok) expect(r.code).toBe(RETCODE.PLACED);
    else expect(r.code).toBe(RETCODE.INVALID_PRICE);
  });

  it("stops are checked against the order price, and the order appears", async () => {
    const { b } = broker();
    expect(
      (await b.placePending({ ...order, type: "BUY_LIMIT", openPrice: 1.08, sl: 1.07995, tp: null })).code,
    ).toBe(RETCODE.INVALID_STOPS);
    expect(
      (await b.placePending({ ...order, type: "BUY_LIMIT", openPrice: 1.08, sl: 1.07989, tp: 1.081 })).ok,
    ).toBe(true);
    expect(
      (await b.placePending({ ...order, type: "BUY_LIMIT", openPrice: 1.08, sl: null, tp: 1.08005 })).code,
    ).toBe(RETCODE.INVALID_STOPS);
    expect(await b.getOrders()).toEqual([
      expect.objectContaining({
        type: "BUY_LIMIT",
        openPrice: 1.08,
        sl: 1.07989,
        tp: 1.081,
        magic: tag.magic,
      }),
    ]);
  });

  it("pending order caps, volume and symbol checks", async () => {
    const { b } = broker({ maxPendingOrders: 1 });
    expect((await b.placePending({ ...order, type: "SELL_STOP", openPrice: 1.085 })).ok).toBe(true);
    expect((await b.placePending({ ...order, type: "SELL_STOP", openPrice: 1.085 })).code).toBe(
      RETCODE.LIMIT_ORDERS,
    );
    expect((await b.placePending({ ...order, type: "SELL_STOP", openPrice: 1.085, volume: 0 })).code).toBe(
      RETCODE.INVALID_VOLUME,
    );
    expect(
      (await b.placePending({ ...order, symbol: "XYZ", type: "SELL_STOP", openPrice: 1.085 })).code,
    ).toBe(RETCODE.INVALID);
  });
});

describe("rate limit (MetaApi credits)", () => {
  it("charges 10 credits per trade; over the window → RATE_LIMITED with retryAfterMs; resets next window", async () => {
    const { b, clock } = broker({ rateLimit: { capacity: 30, windowMs: 10_000, costPerTrade: 10 } });
    for (let i = 0; i < 3; i++) expect((await b.cancelOrder("x")).code).toBe(RETCODE.INVALID_ORDER);
    clock.advance(4_000);
    expect(await b.cancelOrder("x")).toMatchObject({
      code: LOCAL_CODE.RATE_LIMITED,
      class: "retryable",
      retryAfterMs: 6_000,
    });
    clock.advance(6_000);
    expect((await b.cancelOrder("x")).code).toBe(RETCODE.INVALID_ORDER);
  });

  it("defaults to MetaApi's 5,000 credits / 10 s", async () => {
    const b = new MockBroker({
      clock: new ManualClock(0),
      symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    });
    let limited = 0;
    for (let i = 0; i < 501; i++) {
      if ((await b.cancelOrder("x")).code === LOCAL_CODE.RATE_LIMITED) limited += 1;
    }
    expect(limited).toBe(1);
  });
});

describe("faults, connection, recorder, account", () => {
  it("injects configured faults per op", async () => {
    const { b } = broker({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    expect(await b.modifyPosition(seedBuy(b), { sl: 1.08, tp: null })).toMatchObject({
      code: RETCODE.REQUOTE,
      class: "retryable",
    });
  });

  it("disconnected: reads reject, trades return NOT_CONNECTED (retryable, nothing sent)", async () => {
    const { b } = broker();
    b.setConnected(false);
    expect(await b.health()).toEqual({ connected: false, connectedToBroker: false, synchronized: false });
    await expect(b.getPositions()).rejects.toMatchObject({ kind: "NOT_CONNECTED" });
    expect(await b.closePosition("x")).toMatchObject({ code: LOCAL_CODE.NOT_CONNECTED, class: "retryable" });
    b.setConnected(true);
    expect((await b.health()).connected).toBe(true);
    await b.close();
    expect((await b.health()).connected).toBe(false);
  });

  it("records every call with its args and result, in order", async () => {
    const { b } = broker();
    const id = seedBuy(b, { tp: 1.09 });
    await b.modifyPosition(id, { sl: 1.08, tp: 1.09 });
    await b.closePosition(id);
    expect(b.calls.map((c) => [c.index, c.op, c.target])).toEqual([
      [0, "modify", id],
      [1, "close", id],
    ]);
    expect(b.calls[0]?.args).toEqual({ sl: 1.08, tp: 1.09 });
  });

  it("account: equity, margin, margin level; null margin level when flat", async () => {
    const { b } = broker({
      account: { balance: 1000, currency: "EUR", leverage: 100, marginMode: "NETTING" },
    });
    expect(await b.getAccount()).toMatchObject({
      balance: 1000,
      equity: 1000,
      margin: 0,
      marginLevel: null,
      currency: "EUR",
      marginMode: "NETTING",
    });
    seedBuy(b);
    const a = await b.getAccount();
    expect(a.equity).toBe(1010);
    expect(a.margin).toBe(108.5); // 0.1 × 100,000 × 1.085 / 100
    expect(a.marginLevel).toBeCloseTo((1010 / 108.5) * 100, 6);
  });

  it("quotes, specs, sell P/L, unknown symbols", async () => {
    const { b, clock } = broker();
    b.setQuote("EURUSD", 1.087, 1.0871);
    expect(await b.getQuote("EURUSD")).toEqual({
      symbol: "EURUSD",
      bid: 1.087,
      ask: 1.0871,
      time: clock.now(),
    });
    expect(await b.getSymbolSpec("EURUSD")).toEqual(SPEC);
    b.seedPosition({
      id: "s1",
      symbol: "EURUSD",
      side: "SELL",
      volume: 0.2,
      openPrice: 1.088,
      sl: null,
      tp: null,
      magic: 0,
      comment: "hi",
    });
    expect((await b.getPositions())[0]).toMatchObject({ id: "s1", profit: 18, comment: "hi" });
    await expect(b.getQuote("XYZ")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(() => {
      b.setQuote("XYZ", 1, 1);
    }).toThrow(/unknown symbol/);
  });
});
