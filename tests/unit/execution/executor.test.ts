import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { TradeResult } from "@/broker/BrokerProvider";
import { MockBroker, type MockBrokerOptions } from "@/broker/MockBroker";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { CircuitBreaker } from "@/execution/circuitBreaker";
import { execute, send } from "@/execution/executor";
import { CreditLimiter } from "@/execution/rateLimiter";
import type { RetryPolicy } from "@/execution/retries";
import { makeRevalidator } from "@/execution/revalidate";
import { VirtualScheduler } from "@/execution/scheduler";
import { resultsOf, type ExecEvent, type ExecItem } from "@/execution/types";
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
  return { events, summary: complete.summary, results: resultsOf(events) };
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
const modify = (
  positionId: string,
  sl: number | null,
  tp: number | null = null,
  before: { sl: number | null; tp: number | null } = { sl: null, tp: null },
): ExecItem => ({
  op: "modify",
  positionId,
  side: "BUY",
  sl: sl === null ? null : P(sl),
  tp: tp === null ? null : P(tp),
  before: { sl: before.sl === null ? null : P(before.sl), tp: before.tp === null ? null : P(before.tp) },
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

describe("R6.3 / R7.1 / R7.2: re-validate a modify right before retrying it", () => {
  /** First attempt requotes, so a retry (and the revalidator) is needed. */
  const requoteOnce = () => setup({ faults: { modify: [{ rate: 1, code: RETCODE.REQUOTE }] } });

  it("price moved so the level is now invalid: fail with the reason, no second send", async () => {
    const { s, broker, deps } = requoteOnce();
    const id = seedBuy(broker);
    broker.onBeforeCall(() => {
      broker.setQuote("EURUSD", 1.0801, 1.0802);
    }); // price drops right onto the SL
    const { results } = await collect(
      [modify(id, 1.08)],
      { ...deps, revalidate: makeRevalidator(broker, { clock: s }) },
      s,
    );
    expect(results[0]).toMatchObject({ outcome: "failed", attempts: 1 });
    expect(results[0]?.message).toMatch(/price moved, level no longer valid \(R2\.1 BUY SL\)/);
    expect(broker.calls).toHaveLength(1);
  });

  it("already at the levels → done; position closed meanwhile → failed; both without a second send", async () => {
    const { s, broker } = requoteOnce();
    const revalidate = makeRevalidator(broker, { clock: s });
    const a = seedBuy(broker, { sl: 1.08 });
    expect(await s.run(revalidate(modify(a, 1.08, null, { sl: 1.08, tp: null }) as never))).toEqual({
      ok: false,
      alreadyDone: true,
      reason: "already at these levels",
    });
    const b = seedBuy(broker);
    broker.closeExternally(b);
    expect(await s.run(revalidate(modify(b, 1.08) as never))).toEqual({
      ok: false,
      reason: "position is already closed",
    });
  });

  it("R7.1: the owner moved the SL in MT5 after the preview → the TP-only retry is SKIPPED, the SL is never moved back", async () => {
    const { s, broker, deps } = requoteOnce();
    const id = seedBuy(broker, { sl: 1.08, tp: 1.09 });
    // Plan: change TP only; preview saw SL 1.08.
    const item = modify(id, 1.08, 1.091, { sl: 1.08, tp: 1.09 });
    broker.onBeforeCall(({ index }) => {
      if (index === 0) {
        // Between attempt 1 and the retry, the owner moves SL to 1.08300 elsewhere.
        broker.closeExternally("noop");
        broker.seedPosition({
          id,
          symbol: "EURUSD",
          side: "BUY",
          volume: 0.1,
          openPrice: 1.085,
          sl: 1.083,
          tp: 1.09,
          magic: 0,
        });
      }
    });
    const { results } = await collect(
      [item],
      { ...deps, revalidate: makeRevalidator(broker, { clock: s }) },
      s,
    );
    expect(results[0]).toMatchObject({ outcome: "skipped", attempts: 1 });
    expect(results[0]?.message).toMatch(/changed elsewhere since the preview \(R7\.1\)/);
    expect((await s.run(broker.getPositions()))[0]?.sl).toBe(1.083);
  });

  it("R7.2: a stale quote can't validate a retry", async () => {
    const { s, broker } = requoteOnce();
    const id = seedBuy(broker);
    vi.spyOn(broker, "getQuote").mockResolvedValue({
      symbol: "EURUSD",
      bid: 1.086,
      ask: 1.0861,
      time: s.now() - 10_000,
    });
    const v = await s.run(
      makeRevalidator(broker, { clock: s, maxQuoteAgeMs: 3_000 })(modify(id, 1.08) as never),
    );
    expect(v).toEqual({ ok: false, reason: "PRICE_STALE: the latest quote is older than 3000 ms (R7.2)" });
  });

  it("frozen and unusable data are refusals too", async () => {
    const { s, broker } = requoteOnce();
    const revalidate = makeRevalidator(broker, { clock: s });
    broker.seedPosition({
      id: "fz",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: null,
      tp: 1.08604,
      magic: 0,
    });
    expect(await s.run(revalidate(modify("fz", 1.08, 1.08604, { sl: null, tp: 1.08604 }) as never))).toEqual({
      ok: false,
      reason: "frozen: TP is within the freeze level",
    });
    vi.spyOn(broker, "getQuote").mockResolvedValue({ symbol: "EURUSD", bid: 0, ask: 0, time: s.now() });
    expect(await s.run(revalidate(modify(seedBuy(broker), 1.08) as never))).toEqual({
      ok: false,
      reason: "broker data unusable for re-validation",
    });
  });

  it("re-validation that can't read state fails the item instead of guessing", async () => {
    const { s, broker, deps } = requoteOnce();
    const revalidate = () => Promise.reject(new Error("stream down"));
    const { results } = await collect([modify(seedBuy(broker), 1.08)], { ...deps, revalidate }, s);
    expect(results[0]).toMatchObject({
      outcome: "failed",
      message: "couldn't re-validate before retry: stream down",
    });
    const t = requoteOnce();
    const r = await collect(
      [modify(seedBuy(t.broker), 1.08)],
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing a non-Error rejection on purpose
      { ...t.deps, revalidate: () => Promise.reject("plain") },
      t.s,
    );
    expect(r.results[0]?.message).toBe("couldn't re-validate before retry: plain");
  });

  it("re-validates a TP-only modify too", async () => {
    const { s, broker, deps } = requoteOnce();
    const id = seedBuy(broker, { tp: 1.09 });
    const { results } = await collect(
      [modify(id, null, 1.09, { sl: null, tp: 1.09 })],
      { ...deps, revalidate: makeRevalidator(broker, { clock: s }) },
      s,
    );
    expect(results[0]).toMatchObject({ outcome: "done", message: "already at these levels" });
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

  it("modify: late success → done, no second send", async () => {
    const { s, broker, deps } = setup();
    const id = seedBuy(broker);
    scripted(broker, "modifyPosition", {
      op: "modify",
      settled: s.sleep(2_000).then(() => ({ ...done, op: "modify" as const })),
    });
    const spy = vi.spyOn(broker, "modifyPosition");
    const { results } = await collect([modify(id, 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", message: "done (confirmed late)", attempts: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("F3: close does NOT wait on a stuck request (idempotent): it resends after backoff and finishes fast", async () => {
    const { s, broker, deps } = setup();
    const id = seedBuy(broker);
    scripted(broker, "closePosition", { settled: new Promise<TradeResult>(() => undefined) });
    const t0 = s.now();
    const { results } = await collect([close(id)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", attempts: 2 });
    expect(s.now() - t0).toBeLessThan(2_000);
  });

  it("modify that timed out with no way to learn the outcome → unknown, not resent blind", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "modifyPosition", { op: "modify" });
    const spy = vi.spyOn(broker, "modifyPosition");
    const { results } = await collect([modify(seedBuy(broker), 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown", attempts: 1 });
    expect(results[0]?.message).toMatch(/timed out with no confirmation/);
    expect(spy).toHaveBeenCalledTimes(1);
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
    // The position exists with its stop (R5.3b verifies it); the volume read fails once → "volume unknown".
    broker.seedPosition({
      id: "77",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.04,
      openPrice: 1.0861,
      sl: 1.08,
      tp: null,
      magic: 1,
    });
    vi.spyOn(broker, "getPositions").mockRejectedValueOnce(new Error("blip"));
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
      message: "partially filled (R6.7), volume unknown: check",
      positionId: "77",
    });
  });

  it("R6.7: a partial fill reports the volume that actually filled", async () => {
    const { s, broker, deps } = setup();
    broker.seedPosition({
      id: "88",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.04,
      openPrice: 1.0861,
      sl: 1.08,
      tp: null,
      magic: 1,
    });
    scripted(broker, "placeMarket", {
      op: "market",
      ok: true,
      class: "success",
      code: RETCODE.DONE_PARTIAL,
      stringCode: "TRADE_RETCODE_DONE_PARTIAL",
      positionId: "88",
    });
    const { results } = await collect([market("c16")], deps, s);
    expect(results[0]).toMatchObject({
      partial: true,
      filledVolume: 0.04,
      message: "partially filled (R6.7): 0.04 of 0.1 lots",
    });
  });

  it("R6.7: if the volume can't be read, say so", async () => {
    const { s, broker, deps } = setup();
    broker.seedPosition({
      id: "1",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.04,
      openPrice: 1.0861,
      sl: 1.08,
      tp: null,
      magic: 1,
    });
    vi.spyOn(broker, "getPositions").mockRejectedValueOnce(new Error("down"));
    scripted(broker, "placeMarket", {
      op: "market",
      ok: true,
      class: "success",
      code: RETCODE.DONE_PARTIAL,
      stringCode: "TRADE_RETCODE_DONE_PARTIAL",
      positionId: "1",
    });
    expect((await collect([market("c17")], deps, s)).results[0]?.message).toBe(
      "partially filled (R6.7), volume unknown: check",
    );
  });

  it("R5.3b: a partial fill whose position can't be read at all is unknown (stop unverified), not done", async () => {
    const { s, broker, deps } = setup();
    vi.spyOn(broker, "getPositions").mockRejectedValue(new Error("down"));
    scripted(broker, "placeMarket", {
      op: "market",
      ok: true,
      class: "success",
      code: RETCODE.DONE_PARTIAL,
      stringCode: "TRADE_RETCODE_DONE_PARTIAL",
      positionId: "1",
    });
    const r = (await collect([market("c18")], deps, s)).results[0];
    expect(r?.outcome).toBe("unknown");
    expect(r?.message).toMatch(/stop could not be verified/);
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
    ch.close(); // idempotent
    ch.push(3);
    expect(await pending).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});

describe("Phase 04 board review findings", () => {
  it("F1: abort during retry backoff → no further attempts; a sent-then-aborted item is failed, not done", async () => {
    const { s, broker, deps } = setup({ faults: { market: [{ rate: 1, code: RETCODE.REQUOTE }] } });
    const ac = new AbortController();
    const spy = vi.spyOn(broker, "placeMarket");
    // The owner aborts as soon as the first attempt comes back (requote), i.e. during the backoff.
    const { results } = await collect(
      [market("ab1")],
      {
        ...deps,
        signal: ac.signal,
        onCall: () => {
          ac.abort();
        },
      },
      s,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ outcome: "failed", attempts: 1 });
    expect(results[0]?.message).toMatch(/^aborted before retry/);
  });

  it("abort while waiting for credits → nothing sent, skipped", async () => {
    const { s, broker, deps } = setup();
    const ac = new AbortController();
    ac.abort();
    const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
    limiter.pauseFor(1_000);
    const items = [close(seedBuy(broker))];
    const { results } = await collect(items, { ...deps, limiter, signal: ac.signal }, s);
    expect(results[0]).toMatchObject({ outcome: "skipped", attempts: 0 });
    expect(broker.calls).toHaveLength(0);
  });

  it("F4: a 429 that arrives late via `settled` pauses everyone for its retry time", async () => {
    const { s, broker, deps } = setup();
    const id = seedBuy(broker);
    const late: TradeResult = {
      op: "modify",
      ok: false,
      class: "retryable",
      code: LOCAL_CODE.RATE_LIMITED,
      stringCode: "RATE_LIMITED",
      message: "",
      latencyMs: 1,
      retryAfterMs: 5_000,
    };
    scripted(broker, "modifyPosition", { op: "modify", settled: Promise.resolve(late) });
    const { results } = await collect([modify(id, 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "done", attempts: 2 });
    const gap = (broker.calls[0]?.at ?? 0) - 1_763_769_600_000;
    expect(gap).toBeGreaterThanOrEqual(5_000);
  });

  it("F5: two positions found for one entry → unknown 'duplicate', never a clean done", async () => {
    const { s, broker, deps } = setup();
    for (const id of ["p1", "p2"]) {
      broker.seedPosition({
        id,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        openPrice: 1.0861,
        sl: 1.08,
        tp: null,
        magic: 1,
        clientId: "dup1",
      });
    }
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    const { results } = await collect([market("dup1")], deps, s);
    expect(results[0]).toMatchObject({
      outcome: "unknown",
      message: "duplicate positions for one entry (p1, p2): check manually",
    });
  });

  it("the same target twice in one plan: the copy is refused before anything is sent", async () => {
    const { s, broker, deps } = setup();
    const id = seedBuy(broker);
    const { results } = await collect([market("same"), close(id), market("same"), close(id)], deps, s);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done", "skipped", "skipped"]);
    expect(results[2]?.message).toBe("duplicate of item 0 in this plan: not sent");
    expect(broker.calls.filter((c) => c.op === "market")).toHaveLength(1);
  });

  it("reconcilePolls 0 is clamped to 1: reconciliation is never skipped", async () => {
    const { s, broker, deps } = setup({}, 4, { reconcilePolls: 0 });
    scripted(broker, "placeMarket", { op: "market", class: "ambiguous", code: LOCAL_CODE.UNKNOWN_ERROR });
    const spy = vi.spyOn(broker, "reconcile");
    const { results } = await collect([market("rp0")], deps, s);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results[0]?.outcome).toBe("unknown");
  });

  it("nonsense policy/concurrency values fall back to safe defaults", async () => {
    const { s, broker, deps } = setup({}, Number.NaN, {
      maxAttempts: Number.NaN,
      jitter: Number.NaN,
      baseDelayMs: -5,
    });
    const { results, summary } = await collect([close(seedBuy(broker)), close(seedBuy(broker))], deps, s);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done"]);
    expect(summary.finished).toBe(2);
  });

  it("a cost the limiter can never fit → failed with nothing sent", async () => {
    const { s, broker, deps } = setup();
    const { results } = await collect([close(seedBuy(broker))], { ...deps, costPerTrade: 1e9 }, s);
    expect(results[0]).toMatchObject({ outcome: "failed", attempts: 0, code: null });
    expect(results[0]?.message).toMatch(/^can't send: cost/);
    expect(broker.calls).toHaveLength(0);
  });

  it("a throwing logger can't turn a confirmed trade into 'unknown', and the 429 pause still applies", async () => {
    const { s, broker, deps } = setup();
    const { results } = await collect(
      [close(seedBuy(broker))],
      {
        ...deps,
        onCall: () => {
          throw new Error("log down");
        },
      },
      s,
    );
    expect(results[0]?.outcome).toBe("done");
  });

  it("SRE: a hung broker can't stall the batch: settle waits run off the workers", async () => {
    const { s, broker, deps } = setup({}, 2, { settleTimeoutMs: 30_000 });
    const ids = Array.from({ length: 6 }, () => seedBuy(broker));
    for (let i = 0; i < 6; i++) {
      vi.spyOn(broker, "modifyPosition").mockResolvedValueOnce({
        op: "modify",
        ok: false,
        class: "retryable",
        code: LOCAL_CODE.ADAPTER_TIMEOUT,
        stringCode: "ADAPTER_TIMEOUT",
        message: "",
        latencyMs: 5,
        settled: new Promise<TradeResult>(() => undefined),
      });
    }
    const t0 = s.now();
    const { results } = await collect(
      ids.map((id) => modify(id, 1.08)),
      deps,
      s,
    );
    expect(results.every((r) => r.outcome === "unknown")).toBe(true);
    // 6 hung items on 2 workers: in parallel ≈ one settle window, not 3 × 30 s.
    expect(s.now() - t0).toBeLessThan(35_000);
  });

  it("zombies count against the in-flight cap while they may still be live", async () => {
    const t = setup({}, 4, { settleTimeoutMs: 10_000 });
    const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 2, scheduler: t.s });
    vi.spyOn(t.broker, "modifyPosition").mockResolvedValue({
      op: "modify",
      ok: false,
      class: "retryable",
      code: LOCAL_CODE.ADAPTER_TIMEOUT,
      stringCode: "ADAPTER_TIMEOUT",
      message: "",
      latencyMs: 5,
      settled: new Promise<TradeResult>(() => undefined),
    });
    await collect(
      Array.from({ length: 4 }, () => modify(seedBuy(t.broker), 1.08)),
      { ...t.deps, limiter },
      t.s,
    );
    expect(limiter.peakInFlight).toBeLessThanOrEqual(2);
  });
});

describe("last-resort guards", () => {
  it("a 'settled' that breaks its never-reject contract ends the item as unknown", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "modifyPosition", {
      op: "modify",
      settled: Promise.reject(new Error("contract broken")),
    });
    const { results } = await collect([modify(seedBuy(broker), 1.08)], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown", attempts: 1 });
  });

  it("if the run itself crashes, the stream still ends (no consumer waits forever)", async () => {
    const { broker, deps } = setup();
    const broken = {
      ...deps,
      scheduler: {
        now: () => {
          throw new Error("clock broke");
        },
        sleep: () => Promise.resolve(),
      },
    };
    const events: ExecEvent[] = [];
    for await (const e of execute([close(seedBuy(broker))], broken)) events.push(e);
    expect(events).toEqual([]);
  });
});

describe("Channel limits", () => {
  it("closes itself when the reader falls too far behind, and return() closes and notifies", async () => {
    const { Channel } = await import("@/execution/channel");
    let closed = 0;
    const ch = new Channel<number>({ maxBuffer: 2, onClose: () => (closed += 1) });
    ch.push(1);
    ch.push(2);
    ch.push(3);
    expect(ch.overflowed).toBe(true);
    expect(closed).toBe(1);
    const other = new Channel<number>({ onClose: () => (closed += 1) });
    other.push(1);
    expect(await other[Symbol.asyncIterator]().return?.()).toEqual({ value: undefined, done: true });
    expect(closed).toBe(2);
    expect(other.overflowed).toBe(false);
  });
});

describe("restart recovery: the intent to send is recorded before the send", () => {
  it("beforeSend runs for each item before the broker sees it; duplicates never reach it", async () => {
    const { s, broker, deps } = setup({}, 1);
    const a = seedBuy(broker);
    const b = seedBuy(broker);
    const log: string[] = [];
    const real = broker.modifyPosition.bind(broker);
    vi.spyOn(broker, "modifyPosition").mockImplementation((id, levels) => {
      log.push(`send ${id}`);
      return real(id, levels);
    });
    const beforeSend = (index: number) => {
      log.push(`intent ${String(index)}`);
      return Promise.resolve();
    };
    const { results } = await collect(
      [modify(a, 1.08), modify(b, 1.08), modify(a, 1.07)],
      { ...deps, beforeSend },
      s,
    );
    expect(log).toEqual(["intent 0", `send ${a}`, "intent 1", `send ${b}`]);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done", "skipped"]);
  });

  it("normal run: if the intent can't be recorded, that item is NOT sent (failed, says why); the rest run", async () => {
    const { s, broker, deps } = setup({}, 1);
    const a = seedBuy(broker);
    const b = seedBuy(broker);
    const spy = vi.spyOn(broker, "modifyPosition");
    const beforeSend = (index: number) =>
      index === 0 ? Promise.reject(new Error("db down")) : Promise.resolve();
    const { results } = await collect([modify(a, 1.08), modify(b, 1.08)], { ...deps, beforeSend }, s);
    expect(results[0]).toMatchObject({ outcome: "failed", attempts: 0, code: null });
    expect(results[0]?.message).toMatch(/^not sent: couldn't record/);
    expect(results[1]?.outcome).toBe("done");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("urgent (close-now): bookkeeping never blocks or delays the close, even if it fails or hangs", async () => {
    const { s, broker, deps } = setup({}, 1);
    const a = seedBuy(broker);
    const b = seedBuy(broker);
    const calls: number[] = [];
    const beforeSend = (index: number) => {
      calls.push(index);
      return index === 0 ? Promise.reject(new Error("db down")) : new Promise<void>(() => undefined);
    };
    const { results } = await collect([close(a), close(b)], { ...deps, priority: "urgent", beforeSend }, s);
    expect(results.map((r) => r.outcome)).toEqual(["done", "done"]);
    expect(calls).toEqual([0, 1]);
    expect(await s.run(broker.getPositions())).toHaveLength(0);
  });

  it("aborted before start: no intent is recorded for items never picked up", async () => {
    const { s, broker, deps } = setup({}, 1);
    const ctl = new AbortController();
    ctl.abort();
    const beforeSend = vi.fn(() => Promise.resolve());
    const { results } = await collect(
      [close(seedBuy(broker))],
      { ...deps, signal: ctl.signal, beforeSend },
      s,
    );
    expect(results[0]?.outcome).toBe("skipped");
    expect(beforeSend).not.toHaveBeenCalled();
  });
});

describe("circuit breaker: a dead broker fails a batch fast instead of grinding", () => {
  const breakerFor = (s: VirtualScheduler, broker: MockBroker) =>
    new CircuitBreaker({
      threshold: 3,
      cooldownMs: 5_000,
      clock: s,
      probe: async () => (await broker.health()).connected,
    });

  it("normal batch: after K connection failures the rest are 'not sent' without touching the broker", async () => {
    const { s, broker, deps } = setup({}, 2);
    const ids = Array.from({ length: 40 }, () => seedBuy(broker));
    broker.setConnected(false);
    const breaker = breakerFor(s, broker);
    const { results, summary } = await collect(
      ids.map((id) => modify(id, 1.08)),
      { ...deps, breaker },
      s,
    );
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    expect(broker.calls.length).toBeLessThanOrEqual(6);
    const fast = results.filter((r) => r.message.startsWith("not sent: broker unavailable"));
    expect(fast.length).toBeGreaterThanOrEqual(34);
    expect(fast.every((r) => r.attempts === 0)).toBe(true);
    // Without the breaker the same batch takes 40 × 3 attempts with backoff.
    const slow = setup({}, 2);
    const slowIds = Array.from({ length: 40 }, () => seedBuy(slow.broker));
    slow.broker.setConnected(false);
    const baseline = await collect(
      slowIds.map((id) => modify(id, 1.08)),
      slow.deps,
      slow.s,
    );
    expect(slow.broker.calls.length).toBe(120);
    expect(summary.finishedAt - summary.startedAt).toBeLessThan(
      (baseline.summary.finishedAt - baseline.summary.startedAt) / 5,
    );
  });

  it("broker back: after the cooldown one probe lets the next batch through", async () => {
    const { s, broker, deps } = setup({}, 1);
    const breaker = breakerFor(s, broker);
    const a = seedBuy(broker);
    broker.setConnected(false);
    await collect([modify(a, 1.08), modify(seedBuy(broker), 1.08)], { ...deps, breaker }, s);
    expect(breaker.state).toBe("open");
    broker.setConnected(true);
    await s.run(s.sleep(5_000));
    const { results } = await collect([modify(a, 1.08)], { ...deps, breaker }, s);
    expect(results[0]?.outcome).toBe("done");
    expect(breaker.state).toBe("closed");
  });

  it("close-now (urgent) never fails fast: every close is still attempted (R6.6)", async () => {
    const { s, broker, deps } = setup({}, 2);
    const ids = Array.from({ length: 10 }, () => seedBuy(broker));
    broker.setConnected(false);
    const breaker = breakerFor(s, broker);
    const { results } = await collect(ids.map(close), { ...deps, breaker, priority: "urgent" }, s);
    expect(results.every((r) => r.attempts > 0)).toBe(true);
    expect(results.some((r) => r.message.includes("broker unavailable"))).toBe(false);
    expect(breaker.state).toBe("open");
  });
});

describe("R5.3b: an entry counts as filled only when its stop is verified on the position", () => {
  const ops = (b: MockBroker) => b.calls.map((c) => c.op);
  const positionsOf = (b: MockBroker, s: VirtualScheduler) => s.run(b.getPositions());

  it("stop is there → done, and nothing extra is sent", async () => {
    const { s, broker, deps } = setup();
    const { results } = await collect([market("a0")], deps, s);
    expect(results[0]).toMatchObject({
      outcome: "done",
      message: expect.not.stringContaining("stop") as unknown,
    });
    expect(ops(broker)).toEqual(["market"]);
  });

  it("the broker opened it WITHOUT the stop → the stop is set at once, then it's done (both levels, ADR-0008)", async () => {
    const { s, broker, deps } = setup({ dropEntryStops: true });
    const { results } = await collect([market("a0")], deps, s);
    expect(ops(broker)).toEqual(["market", "modify"]);
    expect(results[0]).toMatchObject({ outcome: "done" });
    expect(results[0]?.message).toMatch(/stop was missing after the fill and has been set/);
    const [p] = await positionsOf(broker, s);
    expect(p?.sl).toBe(1.08);
  });

  it("a stop within one tick of the request is accepted as is; two ticks off is corrected", async () => {
    for (const [sl, modifies] of [
      [1.08001, 0],
      [1.08002, 1],
    ] as const) {
      const { s, broker, deps } = setup();
      broker.seedPosition({
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        openPrice: 1.0861,
        sl,
        tp: null,
        magic: 1,
        id: "p-near",
      });
      scripted(broker, "placeMarket", {
        op: "market",
        ok: true,
        class: "success",
        code: RETCODE.DONE,
        stringCode: "DONE",
        message: "",
        latencyMs: 1,
        positionId: "p-near",
      });
      const { results } = await collect([market("a0")], deps, s);
      expect(results[0]?.outcome, String(sl)).toBe("done");
      expect(
        ops(broker).filter((o) => o === "modify"),
        String(sl),
      ).toHaveLength(modifies);
    }
  });

  it("can't set the stop twice → the position is CLOSED and the entry is reported reverted, not filled", async () => {
    const { s, broker, deps } = setup({
      dropEntryStops: true,
      faults: { modify: [{ rate: 1, code: RETCODE.INVALID_STOPS }] },
    });
    const { results } = await collect([market("a0")], deps, s);
    expect(ops(broker)).toEqual(["market", "modify", "modify", "close"]);
    expect(results[0]).toMatchObject({ outcome: "failed", message: "entry reverted: stop could not be set" });
    expect(await positionsOf(broker, s)).toHaveLength(0);
  });

  it("can't set the stop AND can't close → unknown, loudly: a naked position is open", async () => {
    const { s, broker, deps } = setup({
      dropEntryStops: true,
      faults: { modify: [{ rate: 1, code: RETCODE.REJECT }], close: [{ rate: 1, code: RETCODE.REJECT }] },
    });
    const { results } = await collect([market("a0")], deps, s);
    expect(results[0]?.outcome).toBe("unknown");
    expect(results[0]?.message).toMatch(
      /NO STOP and it could not be closed: close it in MT5 NOW \(position /,
    );
    expect(await positionsOf(broker, s)).toHaveLength(1);
  });

  it("the position isn't visible after the fill → unknown (can't verify the stop), never a plain done", async () => {
    const { s, broker, deps } = setup();
    scripted(broker, "placeMarket", {
      op: "market",
      ok: true,
      class: "success",
      code: RETCODE.DONE,
      stringCode: "DONE",
      message: "",
      latencyMs: 1,
      positionId: "ghost",
    });
    const { results } = await collect([market("a0")], deps, s);
    expect(results[0]).toMatchObject({ outcome: "unknown" });
    expect(results[0]?.message).toMatch(/filled, but its stop could not be verified/);
  });

  it("no stop requested (noStop) → nothing to verify; pending orders and close-now are untouched", async () => {
    const { s, broker, deps } = setup({ dropEntryStops: true });
    const noStop: ExecItem = {
      op: "market",
      req: {
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        sl: null,
        tp: null,
        magic: 1,
        comment: "OD:t",
        clientId: "n",
      },
    };
    const { results } = await collect([noStop], deps, s);
    expect(results[0]?.outcome).toBe("done");
    expect(ops(broker)).toEqual(["market"]);
  });

  it("a stop-fix still happens while aborted: a naked position must never be left behind", async () => {
    const { s, broker, deps } = setup({ dropEntryStops: true });
    const ctl = new AbortController();
    const items = [market("a0"), market("a1")];
    broker.onBeforeCall((c) => {
      if (c.op === "market" && c.target === "a0") ctl.abort();
    });
    const { results } = await collect(items, { ...deps, signal: ctl.signal, concurrency: 1 }, s);
    expect(results[0]?.outcome).toBe("done");
    expect((await positionsOf(broker, s))[0]?.sl).toBe(1.08);
  });
});

describe("R9.10: a systemic failure stops the rest of the batch", () => {
  const entries = (n: number): ExecItem[] =>
    Array.from({ length: n }, (_, i) => market(`s${String(i).padStart(3, "0")}`));
  const marketCalls = (b: MockBroker) => b.calls.filter((c) => c.op === "market").length;

  it("the first LIMIT_ORDERS (position cap) fails that item; every item not yet sent is 'not sent', no more calls", async () => {
    const { s, broker, deps } = setup({ maxPositions: 3 }, 1);
    const { results, summary } = await collect(entries(10), deps, s);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual(["done", "done", "done"]);
    expect(results[3]).toMatchObject({ outcome: "failed", code: RETCODE.LIMIT_ORDERS });
    for (const r of results.slice(4)) {
      expect(r).toMatchObject({ outcome: "skipped", attempts: 0, code: null });
      expect(r.message).toMatch(/^not sent: .*stopped the rest of the batch \(R9\.10\)/);
    }
    expect(marketCalls(broker)).toBe(4);
    expect(summary).toMatchObject({ done: 3, failed: 1, skipped: 6, total: 10 });
  });

  it("every systemic code does it; an ordinary refusal (INVALID_STOPS, REQUOTE) does not", async () => {
    for (const code of [
      RETCODE.NO_MONEY,
      RETCODE.LIMIT_VOLUME,
      RETCODE.TRADE_DISABLED,
      RETCODE.MARKET_CLOSED,
      RETCODE.LIMIT_POSITIONS,
    ]) {
      const { s, broker, deps } = setup({ faults: { market: [{ rate: 1, code }] } }, 1);
      const { results } = await collect(entries(5), deps, s);
      expect(marketCalls(broker), String(code)).toBe(1);
      expect(
        results.filter((r) => r.outcome === "skipped"),
        String(code),
      ).toHaveLength(4);
    }
    const { s, broker, deps } = setup({ faults: { market: [{ rate: 1, code: RETCODE.INVALID_STOPS }] } }, 1);
    await collect(entries(5), deps, s);
    expect(marketCalls(broker)).toBe(5); // each fails on its own merits; nothing systemic
  });

  it("with concurrency only items already in flight can still fail; nothing new starts after the first systemic failure", async () => {
    const { s, broker, deps } = setup({ faults: { market: [{ rate: 1, code: RETCODE.NO_MONEY }] } }, 4);
    const { results } = await collect(entries(40), deps, s);
    expect(marketCalls(broker)).toBeLessThanOrEqual(4);
    expect(results.filter((r) => r.outcome === "skipped").length).toBeGreaterThanOrEqual(36);
    expect(results.every((r) => r.outcome === "failed" || r.outcome === "skipped")).toBe(true);
  });

  it("only entries trigger it: failed closes and modifies never stop a batch", async () => {
    const { s, broker, deps } = setup({ faults: { close: [{ rate: 1, code: RETCODE.NO_MONEY }] } }, 1);
    const ids = Array.from({ length: 4 }, () => seedBuy(broker));
    const { results } = await collect(ids.map(close), deps, s);
    expect(results.every((r) => r.outcome === "failed")).toBe(true);
    expect(results.some((r) => r.outcome === "skipped")).toBe(false);
  });
});

describe("R9.11: the fill-drift breaker stops a batch whose fills run away from the expected price", () => {
  const withExpected = (clientId: string, expectedFill: number, sl: number | null = 1.08): ExecItem => ({
    op: "market",
    req: {
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      sl,
      tp: null,
      magic: 1,
      comment: "OD:t",
      clientId,
      expectedFill,
    },
  });
  const marketCalls = (b: MockBroker) => b.calls.filter((c) => c.op === "market").length;

  it("a fill more than the limit from the expected price is reported, and nothing new is sent after it", async () => {
    const { s, broker, deps } = setup({}, 1);
    // The mock fills buys at the ask, 1.0861. Expected 1.0800 is 610 points away; the limit is 50.
    const items = ["a", "b", "c", "d"].map((c) => withExpected(c, 1.08));
    const { results } = await collect(items, { ...deps, maxFillDriftPoints: 50 }, s);
    expect(results[0]).toMatchObject({ outcome: "done", driftPoints: 610 });
    expect(results[0]?.message).toMatch(/filled 610 points from the expected price/);
    for (const r of results.slice(1)) {
      expect(r).toMatchObject({ outcome: "skipped", attempts: 0 });
      expect(r.message).toMatch(
        /^not sent: a fill 610 points from the expected price stopped the rest of the batch \(R9\.11\)$/,
      );
    }
    expect(marketCalls(broker)).toBe(1);
  });

  it("within the limit, or no limit configured → nothing stops; works for no-stop entries too", async () => {
    const near = setup({}, 1);
    const ok1 = await collect(
      ["a", "b", "c"].map((c) => withExpected(c, 1.0859)),
      { ...near.deps, maxFillDriftPoints: 50 },
      near.s,
    );
    expect(ok1.results.map((r) => r.outcome)).toEqual(["done", "done", "done"]);
    const off = setup({}, 1);
    const ok2 = await collect(
      ["a", "b"].map((c) => withExpected(c, 1.08)),
      off.deps,
      off.s,
    );
    expect(ok2.results.map((r) => r.outcome)).toEqual(["done", "done"]);
    const noStop = setup({}, 1);
    const ns = await collect(
      ["a", "b", "c"].map((c) => withExpected(c, 1.08, null)),
      { ...noStop.deps, maxFillDriftPoints: 50 },
      noStop.s,
    );
    expect(ns.results.map((r) => r.outcome)).toEqual(["done", "skipped", "skipped"]);
    expect(ns.results[0]?.driftPoints).toBe(610);
  });
});
