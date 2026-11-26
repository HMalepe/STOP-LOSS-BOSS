import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockBroker } from "@/broker/MockBroker";
import { encodeMagic } from "@/domain/batch";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import { MAX_SWEEPS } from "@/server/trading/manage";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { get, post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let broker: MockBroker;
let svc: TradingServices;
let routes: ReturnType<typeof makeTradingRoutes>;
const PREFIX = 7731;
const A = encodeMagic(PREFIX, 4);
const B = encodeMagic(PREFIX, 9);

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
  routes = makeTradingRoutes(s.guard, () => Promise.resolve(svc));
});
afterEach(async () => {
  await s.db.close();
});

const pos = (magic: number, symbol = "EURUSD") =>
  broker.seedPosition({ symbol, side: "BUY", volume: 0.1, openPrice: 1.08, sl: 1.07, tp: null, magic });
const pend = (magic: number, symbol = "EURUSD") =>
  broker.seedOrder({ symbol, type: "BUY_LIMIT", volume: 0.1, openPrice: 1.05, sl: 1.04, tp: null, magic });
const json = async <T>(res: Response) => (await res.json()) as T;
const planOf = (body: object) => post("/api/plans", body, s.cookie);
const eur = { symbol: "EURUSD", side: "ALL" };

async function finished(executionId: string): Promise<void> {
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
  for (let i = 0; i < 200; i++) {
    const [row] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    if (row?.status === "complete") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("never persisted");
}
async function sweepOf(
  executionId: string,
): Promise<{ passes: number; remaining: number | null; clean: boolean }> {
  for (let i = 0; i < 400; i++) {
    const [row] = await s.db.query<{
      summary: { sweep?: { passes: number; remaining: number | null; clean: boolean } };
    }>("select summary from executions where id = $1", [executionId]);
    if (row?.summary.sweep !== undefined) return row.summary.sweep;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no sweep recorded");
}

describe("GET /api/batches (R9.9)", () => {
  it("lists our batches only, newest first; manual trades and other EAs are invisible", async () => {
    pos(A);
    pos(A);
    pend(A);
    pos(B, "XAUUSD");
    pos(0);
    pos(123);
    const res = await routes.batches(get("/api/batches", s.cookie));
    expect(res.status).toBe(200);
    const { items } = await json<{
      items: {
        batchSeq: number;
        positions: { count: number };
        orders: { count: number };
        symbols: string[];
      }[];
    }>(res);
    expect(items.map((b) => b.batchSeq)).toEqual([9, 4]);
    expect(items[1]).toMatchObject({ symbols: ["EURUSD"], positions: { count: 2 }, orders: { count: 1 } });
  });
  it("needs a session", async () => {
    expect((await routes.batches(get("/api/batches"))).status).toBe(401);
  });
});

describe("cancel pending orders (R4.3 / R4.8)", () => {
  it("previews and cancels only the chosen batch's pending orders; positions and other batches are untouched", async () => {
    const a1 = pend(A);
    const a2 = pend(A);
    const b1 = pend(B);
    const manual = pend(0);
    const keep = pos(A);
    const res = await routes.createPlan(planOf({ action: "cancel", filter: { ...eur, batch: 4 } }));
    expect(res.status).toBe(201);
    const plan = await json<{ id: string; action: string; count: number; breakdown: { cancels: number } }>(
      res,
    );
    expect(plan).toMatchObject({ action: "cancel", count: 2, breakdown: { cancels: 2 } });
    const run = await routes.execute(post(`/api/plans/${plan.id}/execute`, {}, s.cookie), plan.id);
    expect(run.status).toBe(202);
    await finished((await json<{ executionId: string }>(run)).executionId);
    const left = (await broker.getOrders()).map((o) => o.id).sort();
    expect(left).toEqual(expect.arrayContaining([b1, manual]));
    expect(left).not.toContain(a1);
    expect(left).not.toContain(a2);
    expect((await broker.getPositions()).map((p) => p.id)).toContain(keep);
  });
  it("cancel needs no price: a stale or missing quote does not block it", async () => {
    pend(A);
    s.clock.advance(60_000); // far older than MAX_QUOTE_AGE_MS
    const res = await routes.createPlan(planOf({ action: "cancel", filter: { ...eur, batch: 4 } }));
    expect(res.status).toBe(201);
  });
  it("nothing matching is refused with nothing stored; magic AND batch together is a validation error", async () => {
    pend(B);
    const none = await routes.createPlan(planOf({ action: "cancel", filter: { ...eur, batch: 4 } }));
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(await s.db.query("select 1 from plans")).toHaveLength(0);
    const both = await routes.createPlan(
      planOf({ action: "cancel", filter: { ...eur, batch: 4, magic: A } }),
    );
    expect(both.status).toBe(400);
    expect((await json<{ error: { code: string } }>(both)).error.code).toBe("VALIDATION");
  });
  it("the kill switch blocks cancel (only close-now is exempt)", async () => {
    pend(A);
    const res = await routes.createPlan(planOf({ action: "cancel", filter: { ...eur, batch: 4 } }));
    const plan = await json<{ id: string }>(res);
    await setKillSwitch(s.deps, true, s.owner);
    const run = await routes.execute(post(`/api/plans/${plan.id}/execute`, {}, s.cookie), plan.id);
    expect(run.status).toBe(423);
    expect((await broker.getOrders()).length).toBeGreaterThan(0);
  });
});

describe("close-now by batch, with the re-sweep (R4.3)", () => {
  const closeBatch = (batch: number) =>
    routes.closeNow(
      post("/api/close-now", { filter: { ...eur, batch }, cancelPending: true, confirm: "CLOSE" }, s.cookie),
    );

  it("closes only that batch, then a clean re-sweep confirms the book is empty of it", async () => {
    const a = pos(A);
    pend(A);
    const b = pos(B);
    const manual = pos(0);
    const res = await closeBatch(4);
    expect(res.status).toBe(202);
    const { executionId } = await json<{ executionId: string }>(res);
    await finished(executionId);
    expect(await sweepOf(executionId)).toEqual({ passes: 0, remaining: 0, clean: true });
    const ids = (await broker.getPositions()).map((p) => p.id);
    expect(ids).not.toContain(a);
    expect(ids).toEqual(expect.arrayContaining([b, manual]));
    expect((await broker.getOrders()).filter((o) => o.magic === A)).toEqual([]);
    const actions = (await s.db.query<{ action: string }>("select action from audit_log order by id")).map(
      (r) => r.action,
    );
    expect(actions).toContain("close_now.sweep");
  });

  it("a pending order that FILLS while the close runs is caught by the next sweep", async () => {
    pos(A);
    let seeded = false;
    broker.onBeforeCall(() => {
      if (seeded) return;
      seeded = true;
      pos(A); // appears mid-close, as a fill would
    });
    const { executionId } = await json<{ executionId: string }>(await closeBatch(4));
    await finished(executionId);
    expect(await sweepOf(executionId)).toEqual({ passes: 1, remaining: 0, clean: true });
    expect((await broker.getPositions()).filter((p) => p.magic === A)).toEqual([]);
  });

  it(`gives up after ${String(MAX_SWEEPS)} sweeps and says so, instead of claiming done`, async () => {
    pos(A);
    broker.onBeforeCall(() => {
      pos(A); // the book keeps refilling
    });
    const { executionId } = await json<{ executionId: string }>(await closeBatch(4));
    await finished(executionId);
    const sweep = await sweepOf(executionId);
    expect(sweep.passes).toBe(MAX_SWEEPS);
    expect(sweep.clean).toBe(false);
    expect(sweep.remaining).toBeGreaterThan(0);
  });
});
