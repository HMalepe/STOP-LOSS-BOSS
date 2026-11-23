import { describe, expect, it } from "vitest";
import { MockBroker } from "@/broker/MockBroker";
import type { Price, SymbolSpec } from "@/domain/types";
import { InMemoryExecutionStore } from "@/execution/idempotency";
import { InProcessRunner, type Sequenced } from "@/execution/jobRunner";
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
      before: { sl: null, tp: null },
    }));
  return { s, broker, runner, items };
}

async function drain(it: AsyncIterable<Sequenced>): Promise<ExecEvent[]> {
  const out: ExecEvent[] = [];
  for await (const e of it) out.push(e.event);
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
    expect(new Set(results.map((r) => ("executionId" in r ? r.executionId : null))).size).toBe(1);
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
    if (!res.ok) throw new Error("expected a start");
    expect(res.executionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("Phase 04 SRE review: streams, memory, urgency", () => {
  it("events carry sequence numbers; a reconnect resumes after the last seq it saw", async () => {
    const { s, runner, items } = setup();
    await runner.start("p", items(3));
    const all: Sequenced[] = [];
    await s.run(
      (async () => {
        for await (const e of runner.events("ex1")) all.push(e);
      })(),
    );
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    const resumed: number[] = [];
    for await (const e of runner.events("ex1", 1)) resumed.push(e.seq);
    expect(resumed).toEqual([2, 3]);
  });

  it("a subscriber that stops reading is removed (no leak per reconnect)", async () => {
    const { s, runner, items } = setup();
    await runner.start("p", items(5));
    await s.run(
      (async () => {
        for await (const e of runner.events("ex1")) {
          if (e.seq === 0) break; // the phone went away
        }
        await drain(runner.events("ex1"));
      })(),
    );
    expect(runner.status("ex1")?.state).toBe("complete");
  });

  it("a stalled subscriber is cut off at its buffer limit instead of growing memory", async () => {
    const s = new VirtualScheduler(0);
    const broker = new MockBroker({
      clock: s,
      sleep: (ms) => s.sleep(ms),
      symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
      rateLimit: null,
    });
    const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
    const runner = new InProcessRunner({
      broker,
      limiter,
      scheduler: s,
      concurrency: 4,
      random: () => 0.5,
      store: new InMemoryExecutionStore(),
      newId: () => "ex",
      maxSubscriberBuffer: 2,
    });
    const ids = Array.from({ length: 6 }, () =>
      broker.seedPosition({
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.1,
        openPrice: 1.085,
        sl: null,
        tp: null,
        magic: 0,
      }),
    );
    await runner.start(
      "p",
      ids.map((positionId) => ({ op: "close", positionId, side: "BUY", volume: 0.1 })),
    );
    const stalled = runner.events("ex"); // subscribed, never read while it runs
    await s.run(drain(runner.events("ex")));
    const got: number[] = [];
    for await (const e of stalled) got.push(e.seq);
    expect(got.length).toBeLessThanOrEqual(2);
  });

  it("finished executions release their history after retainMs; status stays", async () => {
    const s = new VirtualScheduler(0);
    const broker = new MockBroker({
      clock: s,
      sleep: (ms) => s.sleep(ms),
      symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
      rateLimit: null,
    });
    const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
    const runner = new InProcessRunner({
      broker,
      limiter,
      scheduler: s,
      concurrency: 1,
      store: new InMemoryExecutionStore(),
      newId: () => "ex",
      retainMs: 1_000,
    });
    await runner.start("p", []);
    await s.run(drain(runner.events("ex")));
    await s.run(s.sleep(1_500));
    expect(runner.status("ex")).toMatchObject({ state: "complete", replayable: false });
    expect(await drain(runner.events("ex"))).toEqual([]);
  });

  it("keeps a bounded number of status records (oldest finished first)", async () => {
    const s = new VirtualScheduler(0);
    let n = 0;
    const runner = new InProcessRunner({
      broker: new MockBroker({ clock: s, symbols: [], rateLimit: null }),
      limiter: new CreditLimiter({ capacity: 10, windowMs: 1, maxInFlight: 1, scheduler: s }),
      scheduler: s,
      concurrency: 1,
      store: new InMemoryExecutionStore(),
      newId: () => `e${String(++n)}`,
      maxExecutions: 2,
    });
    for (const p of ["a", "b", "c"]) {
      await runner.start(p, []);
      await s.run(drain(runner.events(`e${String(n)}`)));
    }
    expect(runner.status("e1")).toBeUndefined();
    expect(runner.status("e3")?.state).toBe("complete");
  });

  it("urgent (close-now) aborts every other running execution", async () => {
    const { s, broker, runner, items } = setup();
    await runner.start("bulk", items(30));
    const panic = await runner.start("panic", items(2), { urgent: true });
    expect(panic.ok).toBe(true);
    await s.run(Promise.all([drain(runner.events("ex1")), drain(runner.events("ex2"))]));
    expect(runner.status("ex1")?.summary?.aborted).toBe(true);
    expect(runner.status("ex2")?.summary).toMatchObject({ aborted: false, done: 2 });
    expect(broker.calls.length).toBeLessThan(32);
  });

  it("abortAll (kill switch): stops normal runs, spares the urgent one when asked; activeUrgent finds it", async () => {
    const { s, runner, items } = setup();
    expect(runner.activeUrgent()).toBeUndefined();
    await runner.start("bulk", items(30));
    await runner.start("panic", items(30), { urgent: true });
    expect(runner.activeUrgent()).toBe("ex2");
    await runner.start("bulk2", items(30));
    expect(runner.abortAll({ keepUrgent: true })).toEqual(["ex3"]);
    await s.run(Promise.all([drain(runner.events("ex2")), drain(runner.events("ex3"))]));
    expect(runner.status("ex3")?.summary?.aborted).toBe(true);
    expect(runner.status("ex2")?.summary).toMatchObject({ aborted: false, done: 30 });
    expect(runner.activeUrgent()).toBeUndefined();
    expect(runner.abortAll()).toEqual([]);
  });

  it("a second close-now never cancels the first (both are panic closes)", async () => {
    const { s, runner, items } = setup();
    await runner.start("panicA", items(20), { urgent: true });
    await runner.start("panicB", items(20), { urgent: true });
    await s.run(Promise.all([drain(runner.events("ex1")), drain(runner.events("ex2"))]));
    expect(runner.status("ex1")?.summary).toMatchObject({ aborted: false, done: 20 });
    expect(runner.status("ex2")?.summary).toMatchObject({ aborted: false, done: 20 });
  });

  it("abortAll without keepUrgent stops everything running", async () => {
    const { s, runner, items } = setup();
    await runner.start("panic", items(30), { urgent: true });
    expect(runner.abortAll()).toEqual(["ex1"]);
    await s.run(drain(runner.events("ex1")));
    expect(runner.status("ex1")?.summary?.aborted).toBe(true);
  });

  it("every log line carries its execution id", async () => {
    const s = new VirtualScheduler(0);
    const broker = new MockBroker({
      clock: s,
      sleep: (ms) => s.sleep(ms),
      symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
      rateLimit: null,
    });
    const lines: string[] = [];
    const runner = new InProcessRunner({
      broker,
      limiter: new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s }),
      scheduler: s,
      concurrency: 1,
      store: new InMemoryExecutionStore(),
      newId: () => "exA",
      onCall: (e) => lines.push(`${e.executionId ?? "?"}:${e.op}`),
    });
    const id = broker.seedPosition({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: null,
      tp: null,
      magic: 0,
    });
    await runner.start("p", [{ op: "close", positionId: id, side: "BUY", volume: 0.1 }]);
    await s.run(drain(runner.events("exA")));
    expect(lines).toEqual(["exA:close"]);
  });

  it("the claim store is bounded (oldest claims drop first)", async () => {
    const store = new InMemoryExecutionStore(2);
    await store.claim("a", "1");
    await store.claim("b", "2");
    await store.claim("c", "3");
    expect(await store.claim("c", "x")).toEqual({ executionId: "3", created: false });
    expect(await store.claim("a", "4")).toEqual({ executionId: "4", created: true });
  });
});

describe("restart recovery wiring", () => {
  it("the store gets the items at claim and an intent per item before it is sent, tagged with the execution", async () => {
    const { s, broker } = setup();
    const log: string[] = [];
    const inner = new InMemoryExecutionStore();
    const runner = new InProcessRunner({
      broker,
      limiter: new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s }),
      scheduler: s,
      concurrency: 1,
      random: () => 0.5,
      newId: () => "exR",
      store: {
        claim: (planId, id, items) => {
          log.push(`claim ${planId} ${String(items.length)}`);
          return inner.claim(planId, id);
        },
        markSending: (executionId, index) => {
          log.push(`sending ${executionId} ${String(index)} (calls so far ${String(broker.calls.length)})`);
          return Promise.resolve();
        },
      },
    });
    const id = broker.seedPosition({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: null,
      tp: null,
      magic: 0,
    });
    await runner.start("p", [{ op: "close", positionId: id, side: "BUY", volume: 0.1 }]);
    await s.run(drain(runner.events("exR")));
    expect(log).toEqual(["claim p 1", "sending exR 0 (calls so far 0)"]);
  });
});

describe("graceful shutdown hooks", () => {
  it("stopAccepting: start refuses with SHUTTING_DOWN before claiming (the plan stays executable elsewhere)", async () => {
    const { s, broker, items } = setup();
    const claims: string[] = [];
    const runner = new InProcessRunner({
      broker,
      limiter: new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s }),
      scheduler: s,
      concurrency: 1,
      random: () => 0.5,
      store: {
        claim: (planId, id) => {
          claims.push(planId);
          return Promise.resolve({ executionId: id, created: true });
        },
      },
    });
    runner.stopAccepting();
    expect(await runner.start("p", items(1))).toEqual({ ok: false, code: "SHUTTING_DOWN" });
    expect(claims).toEqual([]);
    expect(broker.calls).toHaveLength(0);
  });

  it("idle resolves once every running execution has completed (immediately when none)", async () => {
    const { s, runner, items } = setup();
    await runner.idle();
    await runner.start("a", items(3));
    await runner.start("b", items(2));
    expect(runner.running()).toEqual(["ex1", "ex2"]);
    let idle = false;
    void runner.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    await s.run(Promise.all([drain(runner.events("ex1")), drain(runner.events("ex2"))]));
    await Promise.resolve();
    expect(idle).toBe(true);
    expect(runner.running()).toEqual([]);
  });
});

describe("runner events (observability)", () => {
  it("every item and the completion reach onEvent with the execution id and urgency; a throwing hook changes nothing", async () => {
    const { s, broker, items } = setup();
    const seen: string[] = [];
    const runner = new InProcessRunner({
      broker,
      limiter: new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s }),
      scheduler: s,
      concurrency: 2,
      random: () => 0.5,
      store: new InMemoryExecutionStore(),
      newId: () => "exO",
      onEvent: (id, e, urgent) => {
        seen.push(`${id}:${e.type}:${String(urgent)}`);
        throw new Error("hook bug");
      },
    });
    await runner.start("p", items(2), { urgent: true });
    const events = await s.run(drain(runner.events("exO")));
    expect(events.map((e) => e.type)).toEqual(["item", "item", "complete"]);
    expect(seen).toEqual(["exO:item:true", "exO:item:true", "exO:complete:true"]);
  });
});
