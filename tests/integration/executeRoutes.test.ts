import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockBroker } from "@/broker/MockBroker";
import { auditKey, verifyChain } from "@/server/audit/audit";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import { PLAN_TTL_MS } from "@/server/trading/plans";
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
const GOLD_BUYS = { symbol: "XAUUSD", side: "BUY" };

async function preview(
  body: Json = { action: "levels", filter: GOLD_BUYS, stopLoss: 2600 },
): Promise<string> {
  const res = await routes.createPlan(post("/api/plans", body, s.cookie));
  if (res.status !== 201) throw new Error(`preview ${String(res.status)}: ${await res.text()}`);
  return String(((await res.json()) as Json).id);
}
const execute = (id: string) => routes.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
async function finished(executionId: string): Promise<void> {
  for await (const { event } of svc.runner.events(executionId)) {
    if (event.type === "complete") break;
  }
  for (let i = 0; i < 100; i++) {
    const [row] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    if (row?.status === "complete") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never persisted");
}
const trades = () => broker.calls.length;
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details?: unknown } }).error;

describe("POST /api/plans/:id/execute", () => {
  it("202, runs exactly the stored items, keeps TP, persists every result, marks the plan executed, audits", async () => {
    const id = await preview({ action: "levels", filter: GOLD_BUYS, takeProfit: 2700 });
    const res = await execute(id);
    expect(res.status).toBe(202);
    const { executionId, count, skipped } = (await res.json()) as {
      executionId: string;
      count: number;
      skipped: unknown[];
    };
    expect([count, skipped]).toEqual([3, []]);
    await finished(executionId);
    expect(broker.calls.map((c) => c.op)).toEqual(["modify", "modify", "modify"]);
    for (const p of (await broker.getPositions()).filter((x) => x.symbol === "XAUUSD" && x.side === "BUY")) {
      expect(p.tp).toBe(2700);
    }
    const items = await s.db.query<{ state: string }>(
      "select state from execution_items where execution_id = $1",
      [executionId],
    );
    expect(items.map((r) => r.state)).toEqual(["done", "done", "done"]);
    expect(await s.db.query("select status from plans where id = $1", [id])).toEqual([
      { status: "executed" },
    ]);
    const status = (await (
      await routes.execution(get(`/api/executions/${executionId}`, s.cookie), executionId)
    ).json()) as Json;
    expect(status).toMatchObject({
      executionId,
      planId: id,
      state: "complete",
      progress: { total: 3, done: 3, ok: 3, failed: 0 },
    });
    const actions = (await s.db.query<{ action: string }>("select action from audit_log order by id")).map(
      (r) => r.action,
    );
    expect(actions.slice(-3)).toEqual(["plan.created", "execution.started", "execution.complete"]);
    expect((await verifyChain(s.db, auditKey(s.deps.sessionSecret))).ok).toBe(true);
  });

  it("docs/06 #4: the same plan twice (and a triple tap) = one set of broker calls; the others get the execution id", async () => {
    const id = await preview();
    const taps = await Promise.all([execute(id), execute(id), execute(id)]);
    const statuses = taps.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409, 409]);
    const winner = taps.find((r) => r.status === 202);
    const { executionId } = (await winner?.json()) as { executionId: string };
    for (const loser of taps.filter((r) => r.status === 409)) {
      expect(await errorOf(loser)).toEqual({
        code: "PLAN_ALREADY_EXECUTED",
        message: "This plan has already been executed.",
        details: { executionId },
      });
    }
    await finished(executionId);
    const again = await execute(id);
    expect(again.status).toBe(409);
    expect(trades()).toBe(3);
  });

  it("expired (30 s) → 409 PLAN_EXPIRED, zero broker calls", async () => {
    const id = await preview();
    s.clock.advance(PLAN_TTL_MS);
    const res = await execute(id);
    expect([res.status, (await errorOf(res)).code, trades()]).toEqual([409, "PLAN_EXPIRED", 0]);
  });

  it("docs/06 #10: kill switch (DB or env) → 423 TRADING_HALTED, zero broker calls", async () => {
    const id = await preview();
    await setKillSwitch(s.deps, true, s.owner);
    const res = await execute(id);
    expect([res.status, (await errorOf(res)).code, trades()]).toEqual([423, "TRADING_HALTED", 0]);
    await setKillSwitch(s.deps, false, s.owner);
    const env = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, envHalted: true }));
    const r2 = await env.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    expect([r2.status, trades()]).toEqual([423, 0]);
  });

  it("docs/06 #12: live without live_enabled → LIVE_NOT_ENABLED; live on a non-REAL account → ACCOUNT_MODE_MISMATCH", async () => {
    const live = (tradeMode: "DEMO" | "REAL") =>
      makeTradingRoutes(s.guard, () =>
        Promise.resolve({ ...svc, broker: asAccount(broker, tradeMode), mode: "live", accountRef: "acc-1" }),
      );
    const id = await preview();
    const r1 = await live("REAL").execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    expect([r1.status, (await errorOf(r1)).code]).toEqual([403, "LIVE_NOT_ENABLED"]);
    // The account type is checked before the opt-in: with live off, a DEMO account still says MISMATCH.
    const r0 = await live("DEMO").execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    expect((await errorOf(r0)).code).toBe("ACCOUNT_MODE_MISMATCH");
    await s.db.query("insert into accounts (metaapi_account_id, live_enabled) values ('acc-1', true)");
    const r2 = await live("DEMO").execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    expect([r2.status, (await errorOf(r2)).code, trades()]).toEqual([403, "ACCOUNT_MODE_MISMATCH", 0]);
  });

  it("docs/06 #5: price moved so the plan is invalid → 409 PRICE_MOVED with reasons, zero broker calls", async () => {
    const id = await preview({ action: "levels", filter: GOLD_BUYS, stopLoss: 2640 });
    broker.setQuote("XAUUSD", 2639.5, 2639.7);
    const res = await execute(id);
    const e = await errorOf(res);
    expect([res.status, e.code, trades()]).toEqual([409, "PRICE_MOVED", 0]);
    expect((e.details as { reason: string }[])[0]?.reason).toMatch(
      /^SL must now be below 2639\.\d\d \(R2\.\d\)$/,
    );
    // The plan is still un-run: it was never claimed.
    expect(await s.db.query("select status from plans where id = $1", [id])).toEqual([{ status: "created" }]);
  });

  it("R7.1: a position changed elsewhere since the preview is skipped up front (never sent); the rest runs", async () => {
    const id = await preview({ action: "levels", filter: GOLD_BUYS, takeProfit: 2700 });
    const [victim] = (await broker.getPositions()).filter((p) => p.symbol === "XAUUSD" && p.side === "BUY");
    await broker.modifyPosition(victim?.id ?? "", { sl: 2500, tp: null }); // the owner, in the MT5 app
    const before = trades();
    const res = await execute(id);
    const body = (await res.json()) as { executionId: string; count: number; skipped: { id: string }[] };
    expect([res.status, body.count, body.skipped.map((x) => x.id)]).toEqual([202, 2, [victim?.id]]);
    await finished(body.executionId);
    expect(broker.calls.slice(before).map((c) => c.target)).not.toContain(victim?.id);
    expect((await broker.getPositions()).find((p) => p.id === victim?.id)).toMatchObject({
      sl: 2500,
      tp: null,
    });
  });

  it("R7.2 at execute: a stale quote → 409 PRICE_STALE, zero calls", async () => {
    const id = await preview();
    const b = broker;
    const stale = makeTradingRoutes(s.guard, () =>
      Promise.resolve({
        ...svc,
        broker: new Proxy(b, {
          get(target, prop, recv) {
            if (prop === "getQuote") {
              return async (x: string) => ({ ...(await target.getQuote(x)), time: s.clock.now() - 3_001 });
            }
            const v: unknown = Reflect.get(target, prop, recv);
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        }),
      }),
    );
    const res = await stale.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    expect([res.status, (await errorOf(res)).code, trades()]).toEqual([409, "PRICE_STALE", 0]);
  });

  it("stored items tampered with after the preview → refused, zero calls", async () => {
    const id = await preview();
    await s.db.query("update plans set items = jsonb_set(items, '{0,sl}', '1.0') where id = $1", [id]);
    const res = await execute(id);
    expect([res.status, (await errorOf(res)).code, trades()]).toEqual([500, "INTERNAL", 0]);
  });

  it("unknown or someone else's plan → 404; no session → 401; broker down → 503", async () => {
    expect((await execute("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const id = await preview();
    expect((await routes.execute(post(`/api/plans/${id}/execute`, {}), id)).status).toBe(401);
    broker.setConnected(false);
    expect((await execute(id)).status).toBe(503);
  });
});

describe("GET /api/executions/:id/stream (SSE)", () => {
  it("item + progress frames with ids, then complete; resumes after Last-Event-ID", async () => {
    const id = await preview();
    const { executionId } = (await (await execute(id)).json()) as { executionId: string };
    await finished(executionId);
    const res = await routes.stream(get(`/api/executions/${executionId}/stream`, s.cookie), executionId);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const text = await res.text();
    expect(text.match(/^event: item$/gm)).toHaveLength(3);
    expect(text.match(/^event: progress$/gm)).toHaveLength(3);
    expect(text).toMatch(/id: 3\nevent: complete\ndata: \{"summary":\{/);
    expect(text).toContain('"ok":true,"outcome":"done"');

    const resumed = await routes.stream(
      new Request(`https://desk.example.com/api/executions/${executionId}/stream`, {
        headers: { cookie: s.cookie, "last-event-id": "1" },
      }),
      executionId,
    );
    const later = await resumed.text();
    expect(later.match(/^event: item$/gm)).toHaveLength(1);
    expect(later).toContain("event: complete");
  });

  it("a run this process doesn't hold → an error event; unknown id → 404", async () => {
    const id = await preview();
    const { executionId } = (await (await execute(id)).json()) as { executionId: string };
    await finished(executionId);
    const other = makeTradingRoutes(s.guard, () => Promise.resolve(mockServices(s.db, s.clock).svc));
    const res = await other.stream(get(`/api/executions/${executionId}/stream`, s.cookie), executionId);
    expect(await res.text()).toMatch(/^event: error\ndata: \{"code":"NOT_FOUND"/);
    const status = (await (
      await other.execution(get(`/api/executions/${executionId}`, s.cookie), executionId)
    ).json()) as Json;
    expect(status).toMatchObject({ state: "complete", summary: { total: 3, done: 3, skippedUpFront: [] } });
    expect((await routes.stream(get("/api/executions/nope/stream", s.cookie), "nope")).status).toBe(404);
    expect((await routes.execution(get("/api/executions/nope", s.cookie), "nope")).status).toBe(404);
  });
});
