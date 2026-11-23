import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import { BrokerError } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import type { PlanItem } from "@/domain/types";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import { HISTORY_PAGE } from "@/server/trading/manage";
import type { TradingServices } from "@/server/trading/services";
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
  await s.db.close();
});

type Json = Record<string, unknown>;
const ALL_GOLD = { symbol: "XAUUSD", side: "ALL" };
const closeAll = (body: Json = { filter: ALL_GOLD, cancelPending: true, confirm: "CLOSE" }, r = routes) =>
  r.closeNow(post("/api/close-now", body, s.cookie));
async function finished(executionId: string): Promise<void> {
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
  for (let i = 0; i < 100; i++) {
    const [row] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    if (row?.status === "complete") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never persisted");
}
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;
const goldLeft = async () => (await broker.getPositions()).filter((p) => p.symbol === "XAUUSD").length;

/** Delegates everything to the mock, overriding some reads. */
function withReads(
  b: MockBroker,
  over: Partial<Pick<BrokerProvider, "getQuote" | "getSymbolSpec">>,
): BrokerProvider {
  return new Proxy(b, {
    get(target, prop, recv) {
      if (prop in over) return over[prop as keyof typeof over];
      const v: unknown = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

describe("POST /api/close-now", () => {
  it("one call: records the plan, closes every matching position biggest loser first, cancels pending, audits", async () => {
    const res = await closeAll();
    expect(res.status).toBe(202);
    const { executionId, plan } = (await res.json()) as { executionId: string; plan: Json };
    expect(plan).toMatchObject({ action: "close", count: 6, breakdown: { buys: 3, sells: 2 } });
    await finished(executionId);
    expect(await goldLeft()).toBe(0);
    expect((await broker.getOrders()).filter((o) => o.symbol === "XAUUSD")).toEqual([]);
    expect(broker.calls.map((c) => c.op)).toEqual(["close", "close", "close", "close", "close", "cancel"]);
    expect((await broker.getPositions()).map((p) => p.symbol)).toEqual(["EURUSD"]);
    const actions = (await s.db.query<{ action: string }>("select action from audit_log order by id")).map(
      (r) => r.action,
    );
    expect(actions.slice(-3)).toEqual(["close_now.requested", "execution.started", "execution.complete"]);
  });

  it("R4.2: works with the kill switch on", async () => {
    await setKillSwitch(s.deps, true, s.owner);
    const res = await closeAll();
    expect(res.status).toBe(202);
    await finished(((await res.json()) as { executionId: string }).executionId);
    expect(await goldLeft()).toBe(0);
  });

  it("closing reduces risk: 'live not enabled' doesn't block it; the wrong account type does", async () => {
    const live = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: asAccount(broker, "REAL"), mode: "live", accountRef: "acc-1" }),
    );
    const ok = await closeAll(undefined, live);
    expect(ok.status).toBe(202);
    await finished(((await ok.json()) as { executionId: string }).executionId);
    broker.seedPosition({
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 2650,
      sl: null,
      tp: null,
      magic: 0,
    });
    // QA review MUST-1: live NOT enabled + a DEMO account must still be refused (the waiver can't hide a mismatch).
    const demoAcct = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: asAccount(broker, "DEMO"), mode: "live", accountRef: "acc-1" }),
    );
    const wrong = await closeAll(undefined, demoAcct);
    expect([wrong.status, (await errorOf(wrong)).code]).toEqual([403, "ACCOUNT_MODE_MISMATCH"]);
    expect(await goldLeft()).toBe(1);
  });

  it("R4.7: a broken quote and spec don't block it", async () => {
    const broken = withReads(broker, {
      getQuote: () => Promise.reject(new BrokerError("BAD_DATA", "quote")),
      getSymbolSpec: () => Promise.reject(new BrokerError("TIMEOUT", "spec")),
    });
    const r = makeTradingRoutes(s.guard, () =>
      Promise.resolve(mockServices(s.db, s.clock, { broker: broken }).svc),
    );
    const res = await closeAll(undefined, r);
    expect(res.status).toBe(202);
    const { plan } = (await res.json()) as { plan: Json };
    expect(plan.quote).toBeNull();
    for (let i = 0; i < 200 && (await goldLeft()) > 0; i++) await new Promise((x) => setTimeout(x, 5));
    expect(await goldLeft()).toBe(0);
  });

  it.each([
    [{ filter: ALL_GOLD }, /CLOSE/],
    [{ filter: ALL_GOLD, confirm: "close" }, /CLOSE/],
    [{ filter: ALL_GOLD, confirm: "CLOSE", extra: 1 }, /extra|body/],
    [{ filter: { symbol: "", side: "ALL" }, confirm: "CLOSE" }, /^filter\.symbol/],
  ])("bad body %j → 400, nothing closed", async (body, message) => {
    const res = await closeAll(body);
    const e = await errorOf(res);
    expect([res.status, e.code]).toEqual([400, "VALIDATION"]);
    expect(e.message).toMatch(message);
    expect(broker.calls).toEqual([]);
  });

  it("nothing matches → 422; broker can't list positions → 503", async () => {
    const none = await closeAll({ filter: { symbol: "EURUSD", side: "SELL" }, confirm: "CLOSE" });
    expect([none.status, (await errorOf(none)).message]).toEqual([422, "Nothing to close."]);
    broker.setConnected(false);
    expect((await closeAll()).status).toBe(503);
  });
});

describe("POST /api/executions/:id/retry-failed", () => {
  async function ranLevels(): Promise<{ planId: string; executionId: string }> {
    const plan = (await (
      await routes.createPlan(
        post(
          "/api/plans",
          { action: "levels", filter: { symbol: "XAUUSD", side: "BUY" }, takeProfit: 2700 },
          s.cookie,
        ),
      )
    ).json()) as Json;
    const planId = String(plan.id);
    const { executionId } = (await (
      await routes.execute(post(`/api/plans/${planId}/execute`, {}, s.cookie), planId)
    ).json()) as {
      executionId: string;
    };
    await finished(executionId);
    return { planId, executionId };
  }
  const retry = (id: string) =>
    routes.retryFailed(post(`/api/executions/${id}/retry-failed`, {}, s.cookie), id);

  it("a new plan of exactly the failed items; unknown ones are never retried (and said so)", async () => {
    const { planId, executionId } = await ranLevels();
    const rows = await s.db.query<{ idx: number; target_id: string }>(
      "select idx, target_id from execution_items where execution_id = $1 order by idx",
      [executionId],
    );
    await s.db.query("update execution_items set state = 'failed' where execution_id = $1 and idx = 0", [
      executionId,
    ]);
    await s.db.query("update execution_items set state = 'unknown' where execution_id = $1 and idx = 1", [
      executionId,
    ]);
    const res = await retry(executionId);
    expect(res.status).toBe(201);
    const summary = (await res.json()) as Json;
    expect(summary).toMatchObject({
      action: "levels",
      symbol: "XAUUSD",
      count: 1,
      breakdown: { buys: 1, sells: 0 },
    });
    expect(summary.warnings).toEqual([
      "Retrying 1 that failed or weren't sent.",
      "1 ended unknown and are NOT retried: check them in MT5.",
    ]);
    const newId = String(summary.id);
    expect(newId).not.toBe(planId);
    const stored = (await (await routes.getPlan(get(`/api/plans/${newId}`, s.cookie), newId)).json()) as {
      items: PlanItem[];
    };
    expect(stored.items.map((i) => (i.op === "cancel" ? i.orderId : i.positionId))).toEqual([
      rows[0]?.target_id,
    ]);
  });

  it("nothing failed → 422 (mentions unknowns); still running → 400; unknown id → 404", async () => {
    const { executionId } = await ranLevels();
    const none = await retry(executionId);
    expect([none.status, (await errorOf(none)).message]).toEqual([422, "Nothing failed."]);
    await s.db.query("update execution_items set state = 'unknown' where execution_id = $1 and idx = 0", [
      executionId,
    ]);
    expect((await errorOf(await retry(executionId))).message).toMatch(/^Nothing failed\. 1 ended unknown/);
    // "running" in the DB but not running anywhere (restart): not STILL_RUNNING forever; it becomes interrupted.
    await s.db.query("update executions set status = 'running' where id = $1", [executionId]);
    expect((await retry(executionId)).status).toBe(422);
    expect(await s.db.query("select status from executions where id = $1", [executionId])).toEqual([
      { status: "interrupted" },
    ]);
    expect((await retry("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await retry("nope")).status).toBe(404);
  });
});

describe("GET /api/history", () => {
  it("newest first, paged with a stable cursor; bad cursor → 400; owner only", async () => {
    for (let i = 0; i < HISTORY_PAGE + 3; i++) {
      const planId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await s.db.query(
        "insert into plans (id, user_id, action, symbol, params, items, input_hash, expires_at, status) values ($1, $2, 'close', 'XAUUSD', '{}', '[]', 'h', now(), 'executed')",
        [planId, s.owner.userId],
      );
      await s.db.query(
        "insert into executions (id, plan_id, started_at, status) values ($1::uuid, $1::text, $2, 'complete')",
        [planId, new Date(Date.UTC(2026, 10, 1) + i * 60_000).toISOString()],
      );
    }
    const page = async (q = "") =>
      (await (await routes.history(get(`/api/history${q}`, s.cookie))).json()) as {
        items: { executionId: string; startedAt: string }[];
        nextCursor: string | null;
      };
    const p1 = await page();
    expect(p1.items).toHaveLength(HISTORY_PAGE);
    expect(p1.items[0]?.executionId.endsWith(String(HISTORY_PAGE + 2).padStart(12, "0"))).toBe(true);
    const p2 = await page(`?cursor=${encodeURIComponent(p1.nextCursor ?? "")}`);
    expect([p2.items.length, p2.nextCursor]).toEqual([3, null]);
    expect(new Set([...p1.items, ...p2.items].map((x) => x.executionId)).size).toBe(HISTORY_PAGE + 3);
    expect((await routes.history(get("/api/history?cursor=garbage", s.cookie))).status).toBe(400);
    expect((await routes.history(get("/api/history"))).status).toBe(401);
  });
});
