import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import { decodeMagic } from "@/domain/batch";
import { auditKey, verifyChain } from "@/server/audit/audit";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { post, signedIn, type SignedIn } from "../helpers/session";

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
  await s.db.close();
});

type Json = Record<string, unknown>;
const market = (o: Json = {}) => ({
  action: "market",
  symbol: "XAUUSD",
  side: "BUY",
  count: 5,
  volume: 0.1,
  sl: { mode: "points", points: 500 },
  tp: { mode: "points", points: 1000 },
  ...o,
});
const ladder = (o: Json = {}) => ({
  action: "ladder",
  symbol: "XAUUSD",
  type: "BUY_LIMIT",
  from: 2640,
  to: 2600,
  spacing: { kind: "levels", levels: 5 },
  lots: { kind: "flat", volume: 0.1 },
  slPoints: 500,
  tpPoints: 1000,
  expiry: { type: "DAY" },
  ...o,
});
async function preview(body: unknown, r = routes): Promise<string> {
  const res = await r.createPlan(post("/api/plans", body, s.cookie));
  if (res.status !== 201) throw new Error(`preview ${String(res.status)} ${await res.text()}`);
  return String(((await res.json()) as Json).id);
}
const exec = (id: string, r = routes) => r.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;
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
const trades = () => broker.calls.length;
const wrap = (over: Partial<BrokerProvider>): BrokerProvider =>
  new Proxy(broker, {
    get(t, prop, recv) {
      if (prop in over) return over[prop as keyof BrokerProvider];
      const v: unknown = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

describe("execute a market batch", () => {
  it("202; every order carries its stop and the batch identity (magic decodes to the plan's batch number); all done; audited", async () => {
    const id = await preview(market());
    const res = await exec(id);
    expect(res.status).toBe(202);
    const { executionId, count } = (await res.json()) as { executionId: string; count: number };
    expect(count).toBe(5);
    await settle(executionId);
    const mine = (await broker.getPositions()).filter((p) => p.clientId !== undefined && p.clientId !== "");
    expect(mine).toHaveLength(5);
    for (const [i, p] of mine.entries()) {
      expect(p).toMatchObject({ symbol: "XAUUSD", side: "BUY", volume: 0.1 });
      expect(p.sl).not.toBeNull();
      expect(p.tp).not.toBeNull();
      expect(decodeMagic(p.magic, 7731)).toEqual({ app: true, batchSeq: 1 });
      expect(p.clientId).toBe(`1${String(i).padStart(3, "0")}`);
      expect(p.comment).toBe("OD:1");
    }
    const states = await s.db.query<{ state: string; target_id: string }>(
      "select state, target_id from execution_items where execution_id = $1 order by idx",
      [executionId],
    );
    expect(states.map((r) => r.state)).toEqual(Array(5).fill("done"));
    expect(states.map((r) => r.target_id)).toEqual(["1000", "1001", "1002", "1003", "1004"]);
    const done = await s.db.query<{ details: Json }>(
      "select details from audit_log where action = 'execution.complete'",
    );
    expect(done[0]?.details).toMatchObject({ outcome: "all_done", total: 5, done: 5 });
    expect((await verifyChain(s.db, auditKey(s.deps.sessionSecret))).ok).toBe(true);
  });

  it("the same plan three times at once = one set of orders (idempotent)", async () => {
    const id = await preview(market());
    const taps = await Promise.all([exec(id), exec(id), exec(id)]);
    expect(taps.map((t) => t.status).sort()).toEqual([202, 409, 409]);
    const winner = taps.find((t) => t.status === 202);
    await settle(((await winner?.json()) as { executionId: string }).executionId);
    expect(
      (await broker.getPositions()).filter((p) => p.clientId !== undefined && p.clientId !== ""),
    ).toHaveLength(5);
    expect(broker.calls.filter((c) => c.op === "market")).toHaveLength(5);
  });
});

describe("execute a ladder", () => {
  it("pending orders at the stored levels, each with its own stop, tagged with the batch", async () => {
    const id = await preview(ladder());
    const res = await exec(id);
    expect(res.status).toBe(202);
    await settle(((await res.json()) as { executionId: string }).executionId);
    const orders = (await broker.getOrders()).filter((o) => o.clientId !== undefined && o.clientId !== "");
    expect(orders.map((o) => o.openPrice).sort()).toEqual([2600, 2610, 2620, 2630, 2640]);
    for (const o of orders) {
      expect(o.type).toBe("BUY_LIMIT");
      expect(o.sl).toBeCloseTo(o.openPrice - 5, 8);
      expect(o.tp).toBeCloseTo(o.openPrice + 10, 8);
      expect(decodeMagic(o.magic, 7731)).toMatchObject({ app: true });
    }
  });
});

describe("refusals: zero broker calls, the plan stays runnable", () => {
  it("docs/06 #10: kill switch (DB) → 423 TRADING_HALTED", async () => {
    const id = await preview(market());
    await setKillSwitch(s.deps, true, s.owner);
    const res = await exec(id);
    expect([res.status, (await errorOf(res)).code, trades()]).toEqual([423, "TRADING_HALTED", 0]);
  });

  it("R9.4 spread guard at EXECUTE time: a spike vs the recorded normal → 409 SPREAD_TOO_WIDE", async () => {
    // 40 calm samples (20 points), each on its own tick.
    for (let i = 0; i < 40; i++) {
      s.clock.advance(1_000);
      svc.entry.sampler.record(
        { symbol: "XAUUSD", bid: 2650.1, ask: 2650.3, time: s.clock.now() },
        { point: 0.01, digits: 2, tickSize: 0.01 },
        s.clock.now(),
      );
    }
    const id = await preview(market());
    broker.setQuote("XAUUSD", 2650.1, 2655.1); // 500 points: 25× normal
    const res = await exec(id);
    const e = await errorOf(res);
    expect([res.status, e.code, trades()]).toEqual([409, "SPREAD_TOO_WIDE", 0]);
    expect(e.message).toMatch(
      /Spread is 500 points; it's normally 20\. Refused until it settles\. Nothing was sent\./,
    );
    broker.setQuote("XAUUSD", 2650.1, 2650.3); // settled → the same plan now runs
    expect((await exec(id)).status).toBe(202);
  });

  it("§7: the market ran through a stored level → 409 PRICE_MOVED, whole plan refused", async () => {
    const id = await preview(market({ sl: { mode: "points", points: 100 } })); // SL 1.00 below the ask
    broker.setQuote("XAUUSD", 2649.2, 2649.4); // the SL must now be below bid − d
    const res = await exec(id);
    const e = await errorOf(res);
    expect([res.status, e.code, trades()]).toEqual([409, "PRICE_MOVED", 0]);
    expect(JSON.stringify(e.details)).toMatch(/SL for a buy must now be below/);
    expect(await s.db.query("select status from plans where id = $1", [id])).toEqual([{ status: "created" }]);
  });

  it("R9.7: free margin fell below what the preview needed → 409 MARGIN_CHANGED", async () => {
    const id = await preview(market());
    const poor = wrap({ getAccount: async () => ({ ...(await broker.getAccount()), freeMargin: 1 }) });
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: poor }));
    const res = await exec(id, r);
    const e = await errorOf(res);
    expect([res.status, e.code, trades()]).toEqual([409, "MARGIN_CHANGED", 0]);
    expect(e.message).toMatch(/Free margin is now 1\.00, below the .* this batch needs/);
  });

  it("a stale quote → 409 PRICE_STALE; expired plan → 409 PLAN_EXPIRED", async () => {
    const id = await preview(market());
    const stale = wrap({
      getQuote: async (x) => ({ ...(await broker.getQuote(x)), time: s.clock.now() - 3_001 }),
    });
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: stale }));
    expect((await errorOf(await exec(id, r))).code).toBe("PRICE_STALE");
    s.clock.advance(30_000);
    expect((await errorOf(await exec(id))).code).toBe("PLAN_EXPIRED");
  });

  it("tampered stored items → refused (hash), zero calls", async () => {
    const id = await preview(market());
    await s.db.query("update plans set items = jsonb_set(items, '{0,sl}', '1.0') where id = $1", [id]);
    const res = await exec(id);
    expect([res.status, trades()]).toEqual([500, 0]);
  });
});

describe("R9.10 a systemic refusal stops the rest", () => {
  it("out of money part-way: later orders are 'not sent', the summary says why, nothing is reported as all done", async () => {
    // The preview's margin check is satisfied by a generous calculator; the account itself then runs dry.
    const generous = wrap({ calculateMargin: () => Promise.resolve(1) });
    const r = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: generous, runner: svc.runner }),
    );
    const id = await preview(
      market({ count: 12, volume: 4, sl: undefined, noStop: true, tp: { mode: "points", points: 1000 } }),
      r,
    );
    // execute against the generous broker's own routes so margin passes, while the runner's mock enforces real funds
    const res = await exec(id, r);
    expect(res.status).toBe(202);
    const { executionId } = (await res.json()) as { executionId: string };
    await settle(executionId);
    const items = await s.db.query<{ state: string; message: string }>(
      "select state, message from execution_items where execution_id = $1 order by idx",
      [executionId],
    );
    const done = items.filter((i) => i.state === "done").length;
    const skipped = items.filter((i) => i.state === "skipped");
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(12);
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0]?.message).toMatch(/^not sent: the batch stopped after TRADE_RETCODE_NO_MONEY/);
    const [row] = await s.db.query<{ summary: { haltedBy?: string; outcome: string } }>(
      "select summary from executions where id = $1",
      [executionId],
    );
    expect(row?.summary).toMatchObject({ haltedBy: "TRADE_RETCODE_NO_MONEY", outcome: "partial" });
  });
});
