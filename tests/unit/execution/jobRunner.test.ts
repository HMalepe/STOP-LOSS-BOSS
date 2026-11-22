import { describe, expect, it } from "vitest";
import { MockBroker } from "@/broker/MockBroker";
import type { Price, SymbolSpec } from "@/domain/types";
import { InMemoryExecutionStore } from "@/execution/idempotency";
import { InProcessRunner } from "@/execution/jobRunner";
import { CreditLimiter } from "@/execution/rateLimiter";
import { VirtualScheduler } from "@/execution/scheduler";
import type { ExecEvent, ExecItem } from "@/execution/types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 0,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 50,
  volumeStep: 0.01,
};

function setup() {
  const s = new VirtualScheduler(0);
  const broker = new MockBroker({
    clock: s,
    sleep: (ms) => s.sleep(ms),
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    rateLimit: null,
  });
  const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
  let n = 0;
  const runner = new InProcessRunner({
    broker,
    limiter,
    scheduler: s,
    concurrency: 4,
    random: () => 0.5,
    store: new InMemoryExecutionStore(),
    newId: () => `ex${String(++n)}`,
  });
  const items = (count: number): ExecItem[] =>
    Array.from({ length: count }, () => ({
      op: "modify",
      positionId: broker.seedPosition({
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        openPrice: 1.085,
        sl: null,
        tp: null,
        magic: 0,
      }),
      side: "BUY",
      sl: 1.08 as Price,
      tp: null,
    }));
  return { s, broker, runner, items };
}

async function drain(it: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const out: ExecEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("idempotent execute (non-negotiable 7, 06-TESTING #4)", () => {
  it("the same planId twice → second is PLAN_ALREADY_EXECUTED with the same execution, broker called once per item", async () => {
    const { s, broker, runner, items } = setup();
    const plan = items(5);
    const first = await runner.start("plan-1", plan);
    const second = await runner.start("plan-1", plan);
    expect(first).toEqual({ ok: true, executionId: "ex1" });
    expect(second).toEqual({ ok: false, code: "PLAN_ALREADY_EXECUTED", executionId: "ex1" });
    await s.run(drain(runner.events("ex1")));
    expect(broker.calls).toHaveLength(5);
  });

  it("a concurrent double tap is still one execution", async () => {
    const { s, broker, runner, items } = setup();
    const plan = items(3);
    const results = await Promise.all([
      runner.start("p", plan),
      runner.start("p", plan),
      runner.start("p", plan),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(new Set(results.map((r) => r.executionId)).size).toBe(1);
    await s.run(drain(runner.events("ex1")));
    expect(broker.calls).toHaveLength(3);
  });

  it("different plans run independently", async () => {
    const { s, broker, runner, items } = setup();
    await runner.start("a", items(2));
    await runner.start("b", items(2));
    await s.run(Promise.all([drain(runner.events("ex1")), drain(runner.events("ex2"))]));
    expect(broker.calls).toHaveLength(4);
  });
});

describe("events and status", () => {
  it("a late subscriber gets the full history, then the end", async () => {
    const { s, runner, items } = setup();
    await runner.start("p", items(4));
    const live = await s.run(drain(runner.events("ex1")));
    const replay = await drain(runner.events("ex1"));
    expect(replay).toEqual(live);
    expect(live.at(-1)?.type).toBe("complete");
    expect(live.filter((e) => e.type === "item")).toHaveLength(4);
  });

  it("status goes running → complete with the summary", async () => {
    const { s, runner, items } = setup();
    await runner.start("p", items(2));
    expect(runner.status("ex1")).toMatchObject({
      planId: "p",
      state: "running",
      progress: { total: 2, finished: 0 },
    });
    await s.run(drain(runner.events("ex1")));
    expect(runner.status("ex1")).toMatchObject({
      state: "complete",
      progress: { finished: 2, done: 2 },
      summary: { done: 2 },
    });
    expect(runner.status("nope")).toBeUndefined();
  });

  it("unknown execution id → empty stream", async () => {
    const { runner } = setup();
    expect(await drain(runner.events("nope"))).toEqual([]);
  });

  it("abort stops new items; abort after completion or of an unknown id is a no-op", async () => {
    const { s, broker, runner, items } = setup();
    await runner.start("p", items(20));
    broker.onBeforeCall(({ index }) => {
      if (index === 2) runner.abort("ex1");
    });
    const events = await s.run(drain(runner.events("ex1")));
    const done = events.at(-1);
    expect(done?.type === "complete" && done.summary.aborted).toBe(true);
    expect(broker.calls.length).toBeLessThan(20);
    expect(runner.abort("ex1")).toBe(false);
    expect(runner.abort("nope")).toBe(false);
  });

  it("generates execution ids by default", async () => {
    const s = new VirtualScheduler(0);
    const r = new InProcessRunner({
      broker: new MockBroker({ clock: s, symbols: [], rateLimit: null }),
      limiter: new CreditLimiter({ capacity: 10, windowMs: 1, maxInFlight: 1, scheduler: s }),
      scheduler: s,
      concurrency: 1,
      store: new InMemoryExecutionStore(),
    });
    const res = await r.start("x", []);
    expect(res.executionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
