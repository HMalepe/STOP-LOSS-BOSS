/** R5.3b: an entry is "done" only when its stop is verified; otherwise repaired, or reverted. */
import { describe, expect, it, vi } from "vitest";
import type { MarketOrderReq, PendingOrderReq, TradeResult } from "@/broker/BrokerProvider";
import { MockBroker } from "@/broker/MockBroker";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { execute } from "@/execution/executor";
import { CreditLimiter } from "@/execution/rateLimiter";
import { VirtualScheduler } from "@/execution/scheduler";
import { resultsOf, type ExecEvent, type ExecItem } from "@/execution/types";
import type { SymbolSpec } from "@/domain/types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 10,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 50,
  volumeStep: 0.01,
};

function setup() {
  const s = new VirtualScheduler(1_763_769_600_000);
  const broker = new MockBroker({
    clock: s,
    sleep: (ms) => s.sleep(ms),
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    rateLimit: null,
    latency: { p50: 50, p99: 100 },
    seed: 3,
  });
  const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
  return { s, broker, deps: { broker, limiter, scheduler: s, concurrency: 2, random: () => 0.5 } };
}
const mreq = (clientId = "c1", sl: number | null = 1.0845): MarketOrderReq => ({
  symbol: "EURUSD",
  side: "BUY",
  volume: 0.1,
  sl,
  tp: 1.09,
  magic: 1,
  comment: "OD:t",
  clientId,
});
const market = (req = mreq()): ExecItem => ({ op: "market", req });
const pending = (sl: number | null = 1.083): ExecItem => ({
  op: "pending",
  req: {
    symbol: "EURUSD",
    type: "BUY_LIMIT",
    volume: 0.1,
    openPrice: 1.084,
    sl,
    tp: 1.09,
    magic: 1,
    comment: "OD:t",
    clientId: "p1",
  } satisfies PendingOrderReq,
});

async function run(items: ExecItem[], deps: ReturnType<typeof setup>["deps"], s: VirtualScheduler) {
  const events: ExecEvent[] = [];
  await s.run(
    (async () => {
      for await (const e of execute(items, deps)) events.push(e);
    })(),
  );
  return resultsOf(events);
}

/** A broker whose market orders fill WITHOUT the stop (the failure R5.3b exists for). */
function dropStopOnFill(broker: MockBroker) {
  const real = broker.placeMarket.bind(broker);
  vi.spyOn(broker, "placeMarket").mockImplementation((req) => real({ ...req, sl: null }));
}

describe("R5.3b stop verification", () => {
  it("a normal entry: stop present → done, no extra credit spent", async () => {
    const { s, broker, deps } = setup();
    const [r] = await run([market()], deps, s);
    expect(r).toMatchObject({ outcome: "done", message: "done" });
    expect(broker.calls.map((c) => c.op)).toEqual(["market"]);
  });

  it("the position opened WITHOUT its stop → the stop is set at once; done, and says so", async () => {
    const { s, broker, deps } = setup();
    dropStopOnFill(broker);
    const [r] = await run([market()], deps, s);
    expect(r).toMatchObject({ outcome: "done", message: "done (its stop was missing and has been set)" });
    expect(broker.calls.map((c) => c.op)).toEqual(["market", "modify"]);
    const [p] = await broker.getPositions();
    expect(p).toMatchObject({ sl: 1.0845, tp: 1.09 });
  });

  it("the repair keeps going wrong → the position is CLOSED and the item FAILS (never a naked position)", async () => {
    const { s, broker, deps } = setup();
    dropStopOnFill(broker);
    vi.spyOn(broker, "modifyPosition").mockResolvedValue({
      op: "modify",
      ok: false,
      class: "final",
      code: RETCODE.INVALID_STOPS,
      stringCode: "TRADE_RETCODE_INVALID_STOPS",
      message: "",
      latencyMs: 1,
    } satisfies TradeResult);
    const [r] = await run([market()], deps, s);
    expect(r).toMatchObject({
      outcome: "failed",
      message: "entry reverted: its stop could not be set, so the position was closed",
    });
    expect(broker.calls.filter((c) => c.op === "close")).toHaveLength(1);
    expect(await broker.getPositions()).toEqual([]);
  });

  it("…and if even the close fails: unknown, loudly 'open without its stop'", async () => {
    const { s, broker, deps } = setup();
    dropStopOnFill(broker);
    const bad = {
      op: "modify",
      ok: false,
      class: "final",
      code: RETCODE.INVALID_STOPS,
      stringCode: "X",
      message: "",
      latencyMs: 1,
    } as TradeResult;
    vi.spyOn(broker, "modifyPosition").mockResolvedValue(bad);
    vi.spyOn(broker, "closePosition").mockResolvedValue({ ...bad, op: "close" });
    const [r] = await run([market()], deps, s);
    expect(r?.outcome).toBe("unknown");
    expect(r?.message).toBe(
      "THIS POSITION IS OPEN WITHOUT ITS STOP and could not be closed: close it in MT5 now",
    );
  });

  it("a position already closed by the broker (stop hit) is not an error", async () => {
    const { s, broker, deps } = setup();
    dropStopOnFill(broker);
    const real = broker.getPositions.bind(broker);
    vi.spyOn(broker, "getPositions").mockImplementation(async () => {
      broker.closeExternally("50000001");
      return real();
    });
    const [r] = await run([market()], deps, s);
    expect(r?.outcome).toBe("done");
  });

  it("a stop within one tick of the request counts as set (float representation can't flip it)", async () => {
    const { s, broker, deps } = setup();
    const real = broker.placeMarket.bind(broker);
    vi.spyOn(broker, "placeMarket").mockImplementation((req) => real({ ...req, sl: 1.0845 + 0.000004 }));
    expect((await run([market()], deps, s))[0]?.message).toBe("done");
  });

  it("R9.2b: an entry the owner asked to open with NO stop is left alone", async () => {
    const { s, broker, deps } = setup();
    const [r] = await run([market(mreq("c2", null))], deps, s);
    expect(r?.outcome).toBe("done");
    expect(broker.calls.map((c) => c.op)).toEqual(["market"]);
  });

  it("a pending order with no stop is cancelled rather than left to fill naked", async () => {
    const { s, broker, deps } = setup();
    const real = broker.placePending.bind(broker);
    vi.spyOn(broker, "placePending").mockImplementation((req) => real({ ...req, sl: null }));
    const [r] = await run([pending()], deps, s);
    expect(r).toMatchObject({
      outcome: "failed",
      message: "entry reverted: the pending order had no stop, so it was cancelled",
    });
    expect(await broker.getOrders()).toEqual([]);
  });

  it("a pending order WITH its stop is done; if the cancel fails it is unknown, loudly", async () => {
    const { s, deps } = setup();
    expect((await run([pending()], deps, s))[0]?.outcome).toBe("done");
    const b2 = setup();
    const real = b2.broker.placePending.bind(b2.broker);
    vi.spyOn(b2.broker, "placePending").mockImplementation((req) => real({ ...req, sl: null }));
    vi.spyOn(b2.broker, "cancelOrder").mockResolvedValue({
      op: "cancel",
      ok: false,
      class: "final",
      code: 1,
      stringCode: "X",
      message: "",
      latencyMs: 1,
    });
    const [r] = await run([pending()], b2.deps, b2.s);
    expect(r?.message).toBe(
      "THIS PENDING ORDER HAS NO STOP and could not be cancelled: cancel it in MT5 now",
    );
  });

  it("an entry found by RECONCILE is verified too (a reconciled position with no stop is never reported as done)", async () => {
    const { s, broker, deps } = setup();
    // The reply is lost, but the order landed WITHOUT its stop.
    await s.run(broker.placeMarket({ ...mreq("c9"), sl: null }));
    vi.spyOn(broker, "placeMarket").mockResolvedValue({
      op: "market",
      ok: false,
      class: "ambiguous",
      code: LOCAL_CODE.UNKNOWN_ERROR,
      stringCode: "UNKNOWN",
      message: "",
      latencyMs: 1,
    });
    const [r] = await run([market(mreq("c9"))], deps, s);
    expect(r).toMatchObject({ outcome: "done", message: "done (its stop was missing and has been set)" });
    expect((await broker.getPositions())[0]?.sl).toBe(1.0845);
  });
});
