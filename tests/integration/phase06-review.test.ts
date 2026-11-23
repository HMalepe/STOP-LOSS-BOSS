/** Regression tests for the Phase 06 security + QA reviews. Each reproduces the finding and asserts the fix. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import type { Sequenced, JobRunner } from "@/execution/jobRunner";
import type { Summary } from "@/execution/types";
import type { PlanItem } from "@/domain/types";
import type { Db } from "@/server/db/sql";
import { makeAdminRoutes } from "@/server/http/adminRoutes";
import { SessionLimiter, BUDGETS } from "@/server/http/sessionLimiter";
import { makeTradingRoutes, MAX_STREAMS_PER_SESSION } from "@/server/http/tradingRoutes";
import { outcomeOf, persistResults, recoverInterrupted } from "@/server/trading/executions";
import { PLAN_TTL_MS } from "@/server/trading/plans";
import { buildRunner, demoMockBroker, type TradingServices } from "@/server/trading/services";
import { SpecCache } from "@/server/trading/specCache";
import { asAccount, mockServices } from "../helpers/services";
import { get, post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let broker: MockBroker;
let svc: TradingServices;
let routes: ReturnType<typeof makeTradingRoutes>;

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
  routes = makeTradingRoutes(s.guard, () => Promise.resolve(svc));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await s.db.close();
});

type Json = Record<string, unknown>;
const BUYS = { symbol: "XAUUSD", side: "BUY" };
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;
async function preview(
  body: Json = { action: "levels", filter: BUYS, takeProfit: 2700 },
  r = routes,
): Promise<string> {
  const res = await r.createPlan(post("/api/plans", body, s.cookie));
  if (res.status !== 201) throw new Error(`preview ${String(res.status)} ${await res.text()}`);
  return String(((await res.json()) as Json).id);
}
const exec = (id: string, r = routes) => r.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
async function settle(executionId: string): Promise<void> {
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
  for (let i = 0; i < 200; i++) {
    const [row] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    if (row?.status !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
}
function delegate(b: MockBroker, over: Partial<BrokerProvider>): BrokerProvider {
  return new Proxy(b, {
    get(t, prop, recv) {
      if (prop in over) return over[prop as keyof BrokerProvider];
      const v: unknown = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe("security H1: the SSE stream survives dropped clients and is bounded", () => {
  /** A run that never produces another event (stuck broker). */
  function stuckRunner(returned: { n: number }): JobRunner {
    return {
      ...svc.runner,
      status: (id) => ({
        executionId: id,
        planId: "p",
        state: "running",
        progress: { total: 1, finished: 0, done: 0, failed: 0, unknown: 0, skipped: 0 },
        replayable: true,
      }),
      events: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Sequenced>>(() => undefined),
          return: () => {
            returned.n++;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        }),
      }),
    };
  }

  it("a cancelled stream releases its slot and its iterator, never throws; the 5th concurrent stream is refused", async () => {
    const id = await preview();
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    await settle(executionId);
    const returned = { n: 0 };
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, runner: stuckRunner(returned) }));
    const open = () => r.stream(get(`/api/executions/${executionId}/stream`, s.cookie), executionId);
    const streams = await Promise.all(Array.from({ length: MAX_STREAMS_PER_SESSION }, open));
    expect(streams.every((x) => x.status === 200)).toBe(true);
    const fifth = await open();
    expect([fifth.status, (await errorOf(fifth)).code]).toEqual([429, "RATE_LIMITED"]);
    for (const x of streams) await x.body?.cancel();
    expect(returned.n).toBe(MAX_STREAMS_PER_SESSION);
    const again = await open();
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });

  it("a client aborting the request ends the stream too", async () => {
    const id = await preview();
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    await settle(executionId);
    const returned = { n: 0 };
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, runner: stuckRunner(returned) }));
    const ac = new AbortController();
    const req = new Request(`https://desk.example.com/api/executions/${executionId}/stream`, {
      headers: { cookie: s.cookie },
      signal: ac.signal,
    });
    const res = await r.stream(req, executionId);
    ac.abort();
    await new Promise((x) => setTimeout(x, 0));
    expect(returned.n).toBe(1);
    await res.body?.cancel();
  });
});

describe("security H2: batch cap", () => {
  it("a preview over MAX_POSITIONS_PER_BATCH is refused and nothing is stored; close-now is exempt", async () => {
    const capped = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, capCeilings: { ...svc.capCeilings, maxPositionsPerBatch: 2 } }),
    );
    const res = await capped.createPlan(
      post("/api/plans", { action: "levels", filter: BUYS, takeProfit: 2700 }, s.cookie),
    );
    const e = await errorOf(res);
    expect([res.status, e.code]).toEqual([422, "PLAN_INVALID"]);
    expect(e.message).toMatch(/at most 2/);
    expect(await s.db.query("select id from plans")).toEqual([]);
    const close = await capped.closeNow(
      post("/api/close-now", { filter: { symbol: "XAUUSD", side: "ALL" }, confirm: "CLOSE" }, s.cookie),
    );
    expect(close.status).toBe(202);
  });
});

describe("security H3: per-session budgets", () => {
  it("reads are throttled with Retry-After; close-now has its own budget and still works", async () => {
    const lim = new SessionLimiter(s.clock);
    const r = makeTradingRoutes(s.guard, () => Promise.resolve(svc), lim);
    for (let i = 0; i < BUDGETS.read.max; i++) {
      expect((await r.history(get("/api/history", s.cookie))).status).toBe(200);
    }
    const res = await r.history(get("/api/history", s.cookie));
    expect([res.status, res.headers.get("retry-after")]).toEqual([429, "5"]);
    const close = await r.closeNow(
      post("/api/close-now", { filter: { symbol: "XAUUSD", side: "ALL" }, confirm: "CLOSE" }, s.cookie),
    );
    expect(close.status).toBe(202);
    s.clock.advance(BUDGETS.read.windowMs);
    expect((await r.history(get("/api/history", s.cookie))).status).toBe(200);
  });

  it("the limiter keeps its key table bounded", () => {
    const lim = new SessionLimiter(s.clock, 3);
    for (const k of ["a", "b", "c", "d"]) expect(lim.take(k, "plan")).toBe(0);
    // "a" was evicted (oldest), so it starts fresh.
    for (let i = 0; i < BUDGETS.plan.max - 1; i++) lim.take("a", "plan");
    expect(lim.take("a", "plan")).toBe(0);
    expect(lim.take("a", "plan")).toBeGreaterThan(0);
  });
});

describe("security M2: expiry is re-checked at the claim", () => {
  it("a slow drift guard that crosses the 30 s → PLAN_EXPIRED, zero trade calls", async () => {
    const id = await preview();
    const b = broker;
    const slow = delegate(b, {
      getQuote: async (x) => {
        const q = await b.getQuote(x);
        s.clock.advance(PLAN_TTL_MS); // the broker took forever
        return { ...q, time: s.clock.now() };
      },
    });
    const r = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: slow, runner: buildRunner(slow, s.db, s.clock) }),
    );
    const res = await exec(id, r);
    expect([res.status, (await errorOf(res)).code, broker.calls.length]).toEqual([409, "PLAN_EXPIRED", 0]);
  });
});

describe("security M3: kill switch ON stops running batches (not close-now)", () => {
  it("the admin route calls onHalt when halting, never when resuming", async () => {
    const onHalt = vi.fn(() => Promise.resolve());
    const admin = makeAdminRoutes(s.guard, () => false, onHalt);
    expect(
      (await admin.killSwitchSet(post("/api/admin/kill-switch", { halted: true }, s.cookie))).status,
    ).toBe(200);
    expect(onHalt).toHaveBeenCalledTimes(1);
    await admin.killSwitchSet(post("/api/admin/kill-switch", { halted: false }, s.cookie));
    expect(onHalt).toHaveBeenCalledTimes(1);
    // A failing hook never turns "halt" into an error: the flag is set either way.
    const broken = makeAdminRoutes(
      s.guard,
      () => false,
      () => Promise.reject(new Error("runner gone")),
    );
    expect(
      (await broken.killSwitchSet(post("/api/admin/kill-switch", { halted: true }, s.cookie))).status,
    ).toBe(200);
  });
});

describe("security M5 / QA MUST-3: nothing stays 'running' forever", () => {
  it("a database failure while saving results → the run is marked interrupted", async () => {
    // A real plan run through a real runner, with result saving pointed at a database that fails on item rows.
    const id = await preview();
    const [plan] = await s.db.query<{ items: PlanItem[] }>("select items from plans where id = $1", [id]);
    const started = await svc.runner.start(id, plan?.items ?? []);
    if (!started.ok) throw new Error("setup");
    const failing: Db = {
      ...s.db,
      query: (text, params) =>
        text.startsWith("insert into execution_items")
          ? Promise.reject(new Error("disk full"))
          : s.db.query(text, params),
    };
    await persistResults(svc.runner, failing, started.executionId, () => Promise.resolve());
    expect(await s.db.query("select status from executions where id = $1", [started.executionId])).toEqual([
      { status: "interrupted" },
    ]);
  });

  it("boot recovery marks runs this process doesn't hold as interrupted; status says so", async () => {
    const id = await preview();
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    await settle(executionId);
    await s.db.query("update executions set status = 'running' where id = $1", [executionId]);
    expect(await recoverInterrupted(s.db, () => true)).toEqual([]);
    const fresh = mockServices(s.db, s.clock).svc;
    const status = (await (
      await makeTradingRoutes(s.guard, () => Promise.resolve(fresh)).execution(
        get(`/api/executions/${executionId}`, s.cookie),
        executionId,
      )
    ).json()) as Json;
    expect(status).toMatchObject({ state: "interrupted", outcome: "interrupted" });
    expect(await recoverInterrupted(s.db, () => false)).toEqual([executionId]);
    expect(await s.db.query("select status from executions where id = $1", [executionId])).toEqual([
      { status: "interrupted" },
    ]);
  });
});

describe("security M6: the audit chain covers item outcomes", () => {
  it("execution.complete carries counts, outcome and a hash of every item result", async () => {
    const id = await preview();
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    await settle(executionId);
    const [row] = await s.db.query<{ details: Json }>(
      "select details from audit_log where action = 'execution.complete' and subject = $1",
      [executionId],
    );
    expect(row?.details).toMatchObject({
      outcome: "all_done",
      total: 3,
      done: 3,
      failed: 0,
      unknown: 0,
      aborted: false,
    });
    expect(String(row?.details.resultsHash)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("QA MUST-2: items a close-now aborted are retryable, never 'nothing failed'", () => {
  it("abort-skipped rows are included in retry-failed", async () => {
    const id = await preview();
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    await settle(executionId);
    await s.db.query(
      "update execution_items set state = 'skipped', message = 'aborted before it was sent' where execution_id = $1 and idx in (1, 2)",
      [executionId],
    );
    const res = await routes.retryFailed(
      post(`/api/executions/${executionId}/retry-failed`, {}, s.cookie),
      executionId,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as Json).count).toBe(2);
  });

  it("status never reads as 'all done' when something failed, was unknown, or the run was aborted", () => {
    const base: Summary = {
      total: 3,
      finished: 3,
      done: 3,
      failed: 0,
      unknown: 0,
      skipped: 0,
      startedAt: 0,
      finishedAt: 1,
      retries: 0,
      aborted: false,
    };
    expect(outcomeOf(base)).toBe("all_done");
    expect(outcomeOf({ ...base, done: 2, failed: 1 })).toBe("partial");
    expect(outcomeOf({ ...base, done: 2, unknown: 1 })).toBe("partial");
    expect(outcomeOf({ ...base, done: 1, skipped: 2, aborted: true })).toBe("aborted");
    expect(outcomeOf({ ...base, total: 0, finished: 0, done: 0 })).toBe("nothing");
  });
});

describe("QA MUST-4: retrying a close-now's failures keeps the close exemption and the urgent lane", () => {
  it("live, live_enabled=false, REAL account: the retry of a close executes", async () => {
    const live: TradingServices = {
      ...svc,
      broker: asAccount(broker, "REAL"),
      mode: "live",
      accountRef: "acc-1",
    };
    const r = makeTradingRoutes(s.guard, () => Promise.resolve(live));
    const close = (await (
      await r.closeNow(
        post("/api/close-now", { filter: { symbol: "XAUUSD", side: "ALL" }, confirm: "CLOSE" }, s.cookie),
      )
    ).json()) as {
      executionId: string;
    };
    await settle(close.executionId);
    await s.db.query("update execution_items set state = 'failed' where execution_id = $1 and idx = 0", [
      close.executionId,
    ]);
    const target = (
      await s.db.query<{ target_id: string }>(
        "select target_id from execution_items where execution_id = $1 and idx = 0",
        [close.executionId],
      )
    )[0]?.target_id;
    broker.seedPosition({
      id: target ?? "x",
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 2650,
      sl: null,
      tp: null,
      magic: 0,
    });
    const retry = (await (
      await r.retryFailed(
        post(`/api/executions/${close.executionId}/retry-failed`, {}, s.cookie),
        close.executionId,
      )
    ).json()) as Json;
    expect(retry).toMatchObject({ action: "close", count: 1 });
    const res = await exec(String(retry.id), r);
    expect(res.status).toBe(202);
    const { executionId } = (await res.json()) as { executionId: string };
    await settle(executionId);
    expect((await broker.getPositions()).filter((p) => p.symbol === "XAUUSD")).toEqual([]);
  });
});

describe("security L3: a close-now double tap joins the running close", () => {
  it("same filter while running → 202 joined with the same execution id; nothing is closed twice", async () => {
    const slowBroker = demoMockBroker(s.clock, {
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))),
    });
    const slow: TradingServices = {
      ...svc,
      broker: slowBroker,
      specs: new SpecCache((x) => slowBroker.getSymbolSpec(x), s.clock),
      runner: buildRunner(slowBroker, s.db, s.clock),
    };
    const r = makeTradingRoutes(s.guard, () => Promise.resolve(slow));
    const body = { filter: { symbol: "XAUUSD", side: "ALL" }, confirm: "CLOSE" };
    const first = (await (await r.closeNow(post("/api/close-now", body, s.cookie))).json()) as {
      executionId: string;
    };
    const second = (await (await r.closeNow(post("/api/close-now", body, s.cookie))).json()) as Json;
    expect(second).toEqual({ executionId: first.executionId, joined: true });
    for await (const { event } of slow.runner.events(first.executionId)) if (event.type === "complete") break;
    const closes = slowBroker.calls.filter((c) => c.op === "close").map((c) => c.target);
    expect(new Set(closes).size).toBe(closes.length);
  });
});

describe("QA SHOULD: quotes and specs at the edges", () => {
  it("R7.2 boundary: a quote exactly 3,000 ms old is accepted at preview and execute; 3,001 is not", async () => {
    const b = broker;
    const aged = (ms: number) =>
      delegate(b, { getQuote: async (x) => ({ ...(await b.getQuote(x)), time: s.clock.now() - ms }) });
    const at = (ms: number) =>
      makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: aged(ms) }));
    const id = await preview(undefined, at(3_000));
    expect((await exec(id, at(3_000))).status).toBe(202);
    const r = await at(3_001).createPlan(
      post("/api/plans", { action: "levels", filter: BUYS, takeProfit: 2700 }, s.cookie),
    );
    expect(r.status).toBe(409);
  });

  it("a crossed quote at execute is bad broker data (503), not 'too old'", async () => {
    const id = await preview();
    broker.setQuote("XAUUSD", 2651, 2650);
    const res = await exec(id);
    expect([res.status, (await errorOf(res)).code, broker.calls.length]).toEqual([
      503,
      "BROKER_UNAVAILABLE",
      0,
    ]);
  });

  it("stops level widened after the preview (cached spec) → PRICE_MOVED, zero calls", async () => {
    // ONE cache, warmed by the preview. The broker widens stops afterwards (news). Without a re-read at execute, the
    // drift guard would check against the cached spec and send modifies the broker then rejects.
    let wide = false;
    const b = broker;
    const specs = new SpecCache(
      async (x) => ({ ...(await b.getSymbolSpec(x)), stopsLevel: wide ? 2_000 : 0 }),
      s.clock,
    );
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, specs }));
    const id = await preview({ action: "levels", filter: BUYS, stopLoss: 2645 }, r);
    wide = true;
    const res = await exec(id, r);
    expect([res.status, (await errorOf(res)).code, broker.calls.length]).toEqual([409, "PRICE_MOVED", 0]);
  });

  it("R7.1 skips are visible in status from the start (live and stored)", async () => {
    const id = await preview();
    const [victim] = (await broker.getPositions()).filter((p) => p.symbol === "XAUUSD" && p.side === "BUY");
    await broker.modifyPosition(victim?.id ?? "", { sl: 2500, tp: null });
    const { executionId } = (await (await exec(id)).json()) as { executionId: string };
    const status = (await (
      await routes.execution(get(`/api/executions/${executionId}`, s.cookie), executionId)
    ).json()) as Json;
    expect(status.skippedUpFront).toEqual([
      { id: victim?.id, reason: "changed elsewhere since the preview (R7.1): not touched" },
    ]);
    await settle(executionId);
  });
});
