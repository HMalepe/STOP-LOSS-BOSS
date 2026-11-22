import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { TradeResult } from "@/broker/BrokerProvider";
import { MockBroker, type MockBrokerOptions } from "@/broker/MockBroker";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { execute, send } from "@/execution/executor";
import { CreditLimiter } from "@/execution/rateLimiter";
import type { RetryPolicy } from "@/execution/retries";
import { makeRevalidator } from "@/execution/revalidate";
import { VirtualScheduler } from "@/execution/scheduler";
import type { ExecEvent, ExecItem } from "@/execution/types";
import type { Price, SymbolSpec } from "@/domain/types";

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
const P = (n: number) => n as Price;

function setup(over: Partial<MockBrokerOptions> = {}, concurrency = 4, retry: Partial<RetryPolicy> = {}) {
  const s = new VirtualScheduler(1_763_769_600_000);
  const broker = new MockBroker({
    clock: s,
    sleep: (ms) => s.sleep(ms),
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    rateLimit: null,
    latency: { p50: 100, p99: 400 },
    seed: 11,
    ...over,
  });
  const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
  const deps = {
    broker,
    limiter,
    scheduler: s,
    concurrency,
    random: () => 0.5,
    retry: { reconcileIntervalMs: 500, ...retry },
  };
  return { s, broker, limiter, deps };
}

async function collect(items: readonly ExecItem[], deps: Parameters<typeof execute>[1], s: VirtualScheduler) {
  const events = await s.run(
    (async () => {
      const out: ExecEvent[] = [];
      for await (const e of execute(items, deps)) out.push(e);
      return out;
    })(),
  );
  const complete = events.at(-1);
  if (complete?.type !== "complete") throw new Error("no complete event");
  return { events, summary: complete.summary, results: complete.items };
}

const seedBuy = (b: MockBroker, over: { sl?: number | null; tp?: number | null; id?: string } = {}) =>
  b.seedPosition({
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    openPrice: 1.085,
    sl: over.sl ?? null,
    tp: over.tp ?? null,
    magic: 0,
    ...(over.id === undefined ? {} : { id: over.id }),
  });
const modify = (positionId: string, sl: number | null, tp: number | null = null): ExecItem => ({
  op: "modify",
  positionId,
  side: "BUY",
  sl: sl === null ? null : P(sl),
  tp: tp === null ? null : P(tp),
});
const close = (positionId: string): ExecItem => ({ op: "close", positionId, side: "BUY", volume: 0.1 });
const market = (clientId: string): ExecItem => ({
  op: "market",
  req: {
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    sl: 1.08,
    tp: null,
    magic: 1,
    comment: "OD:t",
    clientId,
  },
});

describe("core: every item gets an outcome, partial failure is normal", () => {
  it("runs all items, streams one event each, then a summary that adds up", async () => {
    const { s, broker, deps } = setup();
    const ok1 = seedBuy(broker);
    const ok2 = seedBuy(broker);
    const items = [modify(ok1, 1.08), modify(ok2, 1.0859 /* inside stops: invalid */), close("gone")];
    const { events, summary, results } = await collect(items, deps, s);
    expect(events.filter((e) => e.type === "item")).toHaveLength(3);
    expect(results.map((r) => r.outcome)).toEqual(["done", "failed", "done"]);
    expect(results[1]).toMatchObject({
      code: RETCODE.INVALID_STOPS,
      attempts: 1,
      message: "TRADE_RETCODE_INVALID_STOPS",
    });
    expect(results[2]?.code).toBe(RETCODE.POSITION_CLOSED);
    expect(summary).toMatchObject({
      total: 3,
      finished: 3,
      done: 2,
      failed: 1,
      unknown: 0,
      skipped: 0,
      retries: 0,
      aborted: false,
    });
    expect(summary.finishedAt).toBeGreaterThan(summary.startedAt);
  });

  it("an empty plan completes immediately", async () => {
    const { s, deps } = setup();
    const { summary, results } = await collect([], deps, s);
    expect(results).toEqual([]);
    expect(summary).toMatchObject({ total: 0, finished: 0 });
  });

  it("progress counts climb monotonically to the total", async () => {
    const { s, broker, deps } = setup();
    const items = Array.from({ length: 10 }, () => close(seedBuy(broker)));
    const { events } = await collect(items, deps, s);
    const finished = events.flatMap((e) => (e.type === "item" ? [e.progress.finished] : []));
    expect(finished).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("starts items in plan order (priority) and never exceeds the concurrency", async () => {
    const { s, broker, deps } = setup({}, 3);
    const ids = Array.from({ length: 12 }, () => seedBuy(broker));
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const real = broker.closePosition.bind(broker);
    vi.spyOn(broker, "closePosition").mockImplementation(async (id) => {
      started.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const r = await real(id);
      inFlight -= 1;
      return r;
    });
    await collect(ids.map(close), deps, s);
    // Start order is the plan's priority order (finish order varies with latency, and that's fine).
    expect(started).toEqual(ids);
    expect(peak).toBe(3);
  });

  it("abort: stops new work, finishes what's in flight, reports the rest as skipped", async () => {
    const { s, broker, deps } = setup({}, 1);
    const ids = Array.from({ length: 5 }, () => seedBuy(broker));
    const ac = new AbortController();
    broker.onBeforeCall(({ index }) => {
      if (index === 1) ac.abort();
    });
    const { summary, results } = await collect(ids.map(close), { ...deps, signal: ac.signal }, s);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done", "skipped", "skipped", "skipped"]);
    expect(results[2]?.message).toBe("aborted before it was sent");
    expect(summary).toMatchObject({ aborted: true, finished: 5, skipped: 3 });
  });

  it("logs one line per broker call", async () => {
    const { s, broker, deps } = setup({ faults: { close: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const lines: string[] = [];
    await collect(
      [close(seedBuy(broker, { id: "p1" }))],
      {
        ...deps,
        onCall: (e) => lines.push(`${e.op}:${e.targetId}#${String(e.attempt)}:${e.result.stringCode}`),
      },
      s,
    );
    expect(lines).toEqual([
      "close:p1#1:TRADE_RETCODE_REQUOTE",
      "close:p1#2:TRADE_RETCODE_REQUOTE",
      "close:p1#3:TRADE_RETCODE_REQUOTE",
    ]);
  });

  it("a broker that throws (a bug) gives 'unknown', never 'done'", async () => {
    const { s, broker, deps } = setup();
    vi.spyOn(broker, "closePosition").mockRejectedValue(new Error("kaboom"));
    const { results } = await collect([close("x")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown", message: "executor error: kaboom" });
  });

  it("send() dispatches every op to the right broker call", async () => {
    const { broker, s } = setup();
    const spy = {
      modify: vi.spyOn(broker, "modifyPosition"),
      close: vi.spyOn(broker, "closePosition"),
      cancel: vi.spyOn(broker, "cancelOrder"),
      market: vi.spyOn(broker, "placeMarket"),
      pending: vi.spyOn(broker, "placePending"),
    };
    await s.run(
      (async () => {
        await send(broker, modify("1", 1.08, 1.09));
        await send(broker, close("1"));
        await send(broker, { op: "cancel", orderId: "9" });
        await send(broker, market("c1"));
        await send(broker, {
          op: "pending",
          req: {
            symbol: "EURUSD",
            type: "BUY_LIMIT",
            volume: 0.1,
            openPrice: 1.08,
            sl: null,
            tp: null,
            magic: 1,
            comment: "",
            clientId: "c2",
          },
        });
      })(),
    );
    expect(spy.modify).toHaveBeenCalledWith("1", { sl: 1.08, tp: 1.09 });
    for (const fn of Object.values(spy)) expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("§6 retries", () => {
  it("R6.1: at most 3 attempts, then failed with the reason (06-TESTING #6)", async () => {
    const { s, broker, deps } = setup({ faults: { close: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const { results, summary } = await collect([close(seedBuy(broker))], deps, s);
    expect(results[0]).toMatchObject({
      outcome: "failed",
      attempts: 3,
      message: "gave up after 3 attempts: TRADE_RETCODE_REQUOTE",
    });
    expect(summary.retries).toBe(2);
  });

  it("backs off 150 ms × 2^n (jitter centred) between attempts", async () => {
    const { s, broker, deps } = setup({
      faults: { close: [{ rate: 1, code: RETCODE.REQUOTE }] },
      latency: { p50: 1, p99: 1 },
    });
    await collect([close(seedBuy(broker))], deps, s);
    const at = broker.calls.map((c) => c.at - (broker.calls[0]?.at ?? 0));
    // latency 1 ms per call, then 150 then 300 ms backoff.
    expect(at).toEqual([0, 151, 452]);
  });

  it("transient faults recover; final codes are not retried", async () => {
    const { s, broker, deps } = setup({
      faults: { close: [{ rate: 0.5, code: RETCODE.PRICE_CHANGED }] },
      seed: 4,
    });
    const ids = Array.from({ length: 30 }, () => seedBuy(broker));
    const { results } = await collect(ids.map(close), deps, s);
    expect(results.every((r) => r.attempts <= 3)).toBe(true);
    expect(results.filter((r) => r.outcome === "done").length).toBeGreaterThan(20);

    const final = setup({ faults: { modify: [{ rate: 1, code: RETCODE.MARKET_CLOSED }] } });
    const r2 = await collect([modify(seedBuy(final.broker), 1.08)], final.deps, final.s);
    expect(r2.results[0]).toMatchObject({ outcome: "failed", attempts: 1 });
  });

  it("R6.2: a 429 pauses everyone for the server's retry time, then all succeed", async () => {
    const { s, broker, deps } = setup({ rateLimit: { capacity: 50, windowMs: 2_000, costPerTrade: 10 } });
    const ids = Array.from({ length: 12 }, () => seedBuy(broker));
    const { results } = await collect(ids.map(close), deps, s);
    expect(results.every((r) => r.outcome === "done")).toBe(true);
    expect(results.every((r) => r.attempts <= 3)).toBe(true);
    expect(broker.calls.some((c) => c.result.code === LOCAL_CODE.RATE_LIMITED)).toBe(true);
  });

  it("R4.5: a position closed by the broker mid-batch counts as done (06-TESTING #7)", async () => {
    const { s, broker, deps } = setup({}, 1);
    const ids = [seedBuy(broker), seedBuy(broker), seedBuy(broker)];
    broker.onBeforeCall(({ index }) => {
      if (index === 1) broker.closeExternally(ids[1]!);
    });
    const { results } = await collect(ids.map(close), deps, s);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done", "done"]);
  });
});

describe("R6.3 re-validate a modify before retrying it", () => {
  it("price moved so the level is now invalid: fail with the reason, no second send", async () => {
    const { s, broker, deps } = setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const id = seedBuy(broker);
    broker.onBeforeCall(() => {
      broker.setQuote("EURUSD", 1.0801, 1.0802);
    }); // price drops right onto the SL
    const { results } = await collect(
      [modify(id, 1.08)],
      { ...deps, revalidate: makeRevalidator(broker) },
      s,
    );
    expect(results[0]).toMatchObject({ outcome: "failed", attempts: 1 });
    expect(results[0]?.message).toMatch(/price moved, level no longer valid \(R2\.1 BUY SL\)/);
  });

  it("already at the levels → done; closed → failed; set elsewhere → skipped as failed with re-preview", async () => {
    const t = setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const revalidate = makeRevalidator(t.broker);
    const a = seedBuy(t.broker, { sl: 1.08 });
    const b = seedBuy(t.broker);
    const c = seedBuy(t.broker);
    t.broker.closeExternally(b);
    const d = seedBuy(t.broker, { sl: 1.07 });
    const { results } = await collect(
      [modify(a, 1.08), modify(b, 1.08), modify(c, 1.08, null)],
      { ...t.deps, revalidate },
      t.s,
    );
    expect(results.map((r) => [r.outcome, r.message])).toEqual([
      ["done", "already at these levels"],
      ["failed", "position is already closed"],
      ["failed", "gave up after 3 attempts: TRADE_RETCODE_REQUOTE"],
    ]);
    const tp = await collect(
      [{ op: "modify", positionId: d, side: "BUY", sl: P(1.075), tp: null }],
      { ...t.deps, revalidate: async (item) => await revalidate(item) },
      t.s,
    );
    expect(tp.results[0]?.outcome).toBe("failed");
    expect((await revalidate({ op: "modify", positionId: d, side: "BUY", sl: null, tp: null })).ok).toBe(
      false,
    );
    t.broker.seedPosition({
      id: "tpx",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: null,
      tp: 1.09,
      magic: 0,
    });
    expect(await revalidate({ op: "modify", positionId: "tpx", side: "BUY", sl: P(1.08), tp: null })).toEqual(
      { ok: false, reason: "TP was set elsewhere since the preview: re-preview" },
    );
    t.broker.seedPosition({
      id: "fz",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: null,
      tp: 1.08604,
      magic: 0,
    });
    expect(
      await revalidate({ op: "modify", positionId: "fz", side: "BUY", sl: P(1.08), tp: P(1.08604) }),
    ).toEqual({ ok: false, reason: "frozen: TP is within the freeze level" });
  });

  it("re-validation that can't read state fails the item instead of guessing", async () => {
    const { s, broker, deps } = setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const id = seedBuy(broker);
    const revalidate = () => Promise.reject(new Error("stream down"));
    const { results } = await collect([modify(id, 1.08)], { ...deps, revalidate }, s);
    expect(results[0]).toMatchObject({
      outcome: "failed",
      message: "couldn't re-validate before retry: stream down",
    });
    const bad = setup();
    vi.spyOn(bad.broker, "getQuote").mockResolvedValue({ symbol: "EURUSD", bid: 0, ask: 0, time: 0 });
    expect(
      await makeRevalidator(bad.broker)({
        op: "modify",
        positionId: seedBuy(bad.broker),
        side: "BUY",
        sl: P(1.08),
        tp: null,
      }),
    ).toEqual({
      ok: false,
      reason: "broker data unusable for re-validation",
    });
    const thrower = setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const r = await collect(
      [modify(seedBuy(thrower.broker), 1.08)],
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing a non-Error rejection on purpose
      { ...thrower.deps, revalidate: () => Promise.reject("plain") },
      thrower.s,
    );
    expect(r.results[0]?.message).toBe("couldn't re-validate before retry: plain");
  });
});

/** A broker whose next call returns this (then behaves normally). */
function scripted(
  broker: MockBroker,
  method: "closePosition" | "modifyPosition" | "placeMarket",
  result: Partial<TradeResult>,
) {
  vi.spyOn(broker, method).mockResolvedValueOnce({
    op: "close",
    ok: false,
    class: "retryable",
    code: LOCAL_CODE.ADAPTER_TIMEOUT,
    stringCode: "ADAPTER_TIMEOUT",
    message: "",
    latencyMs: 5,
    ...result,
  });
}

describe("zombie rule: a timed-out call must settle before we move on", () => {
  const done: TradeResult = {
    op: "close",
    ok: true,
    class: "success",
    code: RETCODE.DONE,
    stringCode: "TRADE_RETCODE_DONE",
    message: "",
    latencyMs: 9,
  };

  it("late success → done, no second send", async () => {
    const { s, broker, deps } = setup();
    const id = seedBuy(broker);
    scripted(broker, "closePosition", { settled: s.sleep(2_000).then(() => done) });
    const { results } = await collect([close(id)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", message: "done (confirmed late)", attempts: 1 });
  });

  it("late final failure → failed with that reason", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "modifyPosition", {
      op: "modify",
      settled: Promise.resolve({
        ...done,
        op: "modify",
        ok: false,
        class: "final",
        code: 10016,
        stringCode: "TRADE_RETCODE_INVALID_STOPS",
      }),
    });
    const { results } = await collect([modify(seedBuy(broker), 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "failed", code: 10016, attempts: 1 });
  });

  it("late retryable failure → retried normally", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "closePosition", {
      settled: Promise.resolve({ ...done, ok: false, class: "retryable", code: RETCODE.REQUOTE }),
    });
    const { results } = await collect([close(seedBuy(broker))], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", attempts: 2 });
  });

  it("never settles → unknown after the window, never 'done', never resent", async () => {
    const { s, broker, deps } = setup({}, 4, { settleTimeoutMs: 30_000 });
    scripted(broker, "modifyPosition", { op: "modify", settled: new Promise<TradeResult>(() => undefined) });
    const { results } = await collect([modify(seedBuy(broker), 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown", attempts: 1 });
    expect(results[0]?.message).toMatch(/may still land/);
    expect(s.now() - 1_763_769_600_000).toBeGreaterThanOrEqual(30_000);
  });
});

describe("ADR-0009: entries with an unknown outcome are never doubled", () => {
  it("lost reply, landed immediately → settled confirms → done with the ticket, one position", async () => {
    const { s, broker, deps } = setup({ lostReplyRate: 1 });
    const { results } = await collect([market("c1")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", message: "done (confirmed late)", attempts: 1 });
    expect(results[0]?.positionId).toBeDefined();
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it("lost reply that lands 20 s later → waits, confirms, still exactly one position", async () => {
    const { s, broker, deps } = setup({ lostReplyRate: 1, lostReplyDelayMs: 20_000 });
    const { results } = await collect([market("c1")], deps, s);
    expect(results[0]?.outcome).toBe("done");
    expect(broker.calls.filter((c) => c.op === "market")).toHaveLength(1);
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it("stuck forever (never lands, never settles) → reconcile says in flight → unknown, not retried", async () => {
    const { s, broker, deps } = setup({ lostReplyRate: 1, lostReplyDelayMs: Number.POSITIVE_INFINITY }, 4, {
      settleTimeoutMs: 5_000,
    });
    const { results } = await collect([market("c1")], deps, s);
    expect(results[0]).toMatchObject({
      outcome: "unknown",
      attempts: 1,
      message: "still being processed by the broker: check manually",
    });
    expect(broker.calls.filter((c) => c.op === "market")).toHaveLength(1);
  });

  it("no settled, reconcile finds the position → done", async () => {
    const { s, broker, deps } = setup();
    broker.seedPosition({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.0861,
      sl: 1.08,
      tp: null,
      magic: 1,
      clientId: "c7",
    });
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    const { results } = await collect([market("c7")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", message: "placed (confirmed by reconcile)" });
    expect(results[0]?.positionId).toBeDefined();
  });

  it("no settled, reconcile finds a pending order → done with the order id", async () => {
    const { s, broker, deps } = setup();
    await s.run(
      broker.placePending({
        symbol: "EURUSD",
        type: "BUY_LIMIT",
        volume: 0.1,
        openPrice: 1.08,
        sl: null,
        tp: null,
        magic: 1,
        comment: "",
        clientId: "c8",
      }),
    );
    scripted(broker, "placeMarket", { op: "pending", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    const { results } = await collect([market("c8")], deps, s);
    expect(results[0]?.orderId).toBeDefined();
  });

  it("no settled, not found after polling → unknown 'check manually', NOT retried", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    const { results } = await collect([market("c9")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown", attempts: 1 });
    expect(results[0]?.message).toMatch(/never retried, ADR-0009/);
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it("settled says definitely not placed (requote) + not found → retry → done", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", {
      op: "market",
      class: "ambiguous",
      settled: Promise.resolve({
        op: "market",
        ok: false,
        class: "retryable",
        code: RETCODE.REQUOTE,
        stringCode: "TRADE_RETCODE_REQUOTE",
        message: "",
        latencyMs: 1,
      }),
    });
    const { results } = await collect([market("c10")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", attempts: 2 });
    expect(await broker.getPositions()).toHaveLength(1);
  });

  it("definitely not placed, but out of attempts → failed", async () => {
    const { s, broker, deps } = setup({}, 4, { maxAttempts: 1 });
    scripted(broker, "placeMarket", {
      op: "market",
      class: "ambiguous",
      settled: Promise.resolve({
        op: "market",
        ok: false,
        class: "retryable",
        code: RETCODE.REQUOTE,
        stringCode: "TRADE_RETCODE_REQUOTE",
        message: "",
        latencyMs: 1,
      }),
    });
    const { results } = await collect([market("c11")], deps, s);
    expect(results[0]?.outcome).toBe("failed");
  });

  it("settled final → failed; settled success → done", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", {
      op: "market",
      class: "ambiguous",
      settled: Promise.resolve({
        op: "market",
        ok: false,
        class: "final",
        code: RETCODE.NO_MONEY,
        stringCode: "TRADE_RETCODE_NO_MONEY",
        message: "",
        latencyMs: 1,
      }),
    });
    expect((await collect([market("c12")], deps, s)).results[0]).toMatchObject({
      outcome: "failed",
      code: RETCODE.NO_MONEY,
    });
  });

  it("can't read the state to reconcile → unknown", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    vi.spyOn(broker, "reconcile").mockRejectedValue(new Error("stream down"));
    const { results } = await collect([market("c13")], deps, s);
    expect(results[0]?.message).toBe("couldn't check whether it was placed (stream down): check manually");
    const t = setup();
    scripted(t.broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    vi.spyOn(t.broker, "reconcile").mockRejectedValue("plain");
    expect((await collect([market("c14")], t.deps, t.s)).results[0]?.message).toMatch(/\(plain\)/);
  });

  it("R6.7: a partial entry fill is done but flagged", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", {
      op: "market",
      ok: true,
      class: "success",
      code: RETCODE.DONE_PARTIAL,
      stringCode: "TRADE_RETCODE_DONE_PARTIAL",
      positionId: "77",
    });
    const { results } = await collect([market("c15")], deps, s);
    expect(results[0]).toMatchObject({
      outcome: "done",
      partial: true,
      message: "partially filled (R6.7)",
      positionId: "77",
    });
  });

  it("property: random faults, lost replies and delays never double a position or exceed 3 attempts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000 }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        fc.constantFrom(0, 2_000, 20_000, Number.POSITIVE_INFINITY),
        async (seed, faultRate, lostRate, delay) => {
          const { s, broker, deps } = setup(
            {
              seed,
              lostReplyRate: lostRate,
              lostReplyDelayMs: delay,
              faults: { market: [{ rate: faultRate, code: RETCODE.REQUOTE }] },
            },
            4,
            { settleTimeoutMs: 30_000 },
          );
          const items = Array.from({ length: 8 }, (_, i) => market(`c${String(i)}`));
          const { results } = await collect(items, deps, s);
          const visible = await broker.getPositions();
          for (const r of results) {
            expect(r.attempts).toBeLessThanOrEqual(3);
            expect(visible.filter((p) => p.clientId === r.targetId).length).toBeLessThanOrEqual(1);
          }
          // A position created by any attempt is never accompanied by a second one for the same clientId, even hidden ones.
          const entries = broker.calls.filter(
            (c) => c.op === "market" && (c.result.ok || c.result.class === "ambiguous"),
          );
          const perClient = new Map<string, number>();
          for (const c of entries) perClient.set(c.target, (perClient.get(c.target) ?? 0) + 1);
          for (const n of perClient.values()) expect(n).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("coverage of the remaining paths", () => {
  it("cancel and pending items run and report their target ids", async () => {
    const { s, broker, deps } = setup();
    const orderId = broker.seedOrder({
      symbol: "EURUSD",
      type: "BUY_LIMIT",
      volume: 0.1,
      openPrice: 1.08,
      sl: null,
      tp: null,
      magic: 0,
    });
    const pending: ExecItem = {
      op: "pending",
      req: {
        symbol: "EURUSD",
        type: "BUY_LIMIT",
        volume: 0.1,
        openPrice: 1.08,
        sl: null,
        tp: null,
        magic: 1,
        comment: "",
        clientId: "pc1",
      },
    };
    const { results } = await collect([{ op: "cancel", orderId }, pending], deps, s);
    expect(results.map((r) => [r.op, r.targetId, r.outcome])).toEqual([
      ["cancel", orderId, "done"],
      ["pending", "pc1", "done"],
    ]);
    expect(results[1]?.orderId).toBeDefined();
  });

  it("a failure message from the broker is kept in the reason", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "closePosition", {
      class: "final",
      code: RETCODE.TRADE_DISABLED,
      stringCode: "TRADE_RETCODE_TRADE_DISABLED",
      message: "Trade disabled",
    });
    const { results } = await collect([close("x")], deps, s);
    expect(results[0]?.message).toBe("TRADE_RETCODE_TRADE_DISABLED: Trade disabled");
  });

  it("re-validates a TP-only modify too", async () => {
    const { s, broker, deps } = setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const id = seedBuy(broker, { tp: 1.09 });
    const { results } = await collect(
      [modify(id, null, 1.09)],
      { ...deps, revalidate: makeRevalidator(broker) },
      s,
    );
    expect(results[0]).toMatchObject({ outcome: "done", message: "already at these levels" });
  });

  it("a reconcile answer missing the id counts as not found", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    vi.spyOn(broker, "reconcile").mockResolvedValue(new Map());
    expect((await collect([market("c20")], deps, s)).results[0]?.outcome).toBe("unknown");
  });

  it("uses Math.random for jitter when none is injected, and reports non-Error crashes", async () => {
    const { s, broker, deps } = setup({ faults: { close: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const noRandom = {
      broker: deps.broker,
      limiter: deps.limiter,
      scheduler: deps.scheduler,
      concurrency: deps.concurrency,
      retry: deps.retry,
    };
    const { results } = await collect([close(seedBuy(broker))], noRandom, s);
    expect(results[0]?.attempts).toBe(3);
    const t = setup();
    vi.spyOn(t.broker, "closePosition").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw on purpose
      throw "string crash";
    });
    expect((await collect([close("x")], t.deps, t.s)).results[0]?.message).toBe(
      "executor error: string crash",
    );
  });
});

describe("Channel", () => {
  it("buffers, hands values to waiting readers, ignores pushes after close", async () => {
    const { Channel } = await import("@/execution/channel");
    const ch = new Channel<number>();
    const it = ch[Symbol.asyncIterator]();
    const waiting = it.next();
    ch.push(1);
    ch.push(2);
    expect(await waiting).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
    const pending = it.next();
    ch.close();
    ch.push(3);
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});
