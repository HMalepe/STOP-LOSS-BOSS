/** Phase 08 M3a: Order Desk entries through the real routes, runner, database and mock broker. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import { setKillSwitch } from "@/server/killSwitch";
import { makeSettingsRoutes } from "@/server/http/settingsRoutes";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import type { StoredItem } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let svc: TradingServices;
let broker: MockBroker;
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
const MARKET = {
  action: "market",
  symbol: "EURUSD",
  side: "BUY",
  count: 3,
  volume: 0.05,
  stopLoss: { kind: "points", value: 150 },
  takeProfit: { kind: "points", value: 300 },
};
const LADDER = {
  action: "ladder",
  symbol: "EURUSD",
  side: "BUY",
  kind: "limit",
  from: 1.085,
  to: 1.083,
  spacing: { mode: "count", levels: 3 },
  lots: { mode: "flat", lot: 0.1 },
  slOffsetPoints: 200,
};
const preview = (body: Json, r = routes) => r.createPlan(post("/api/plans", body, s.cookie));
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;
async function planId(body: Json, r = routes): Promise<string> {
  const res = await preview(body, r);
  if (res.status !== 201) throw new Error(`preview ${String(res.status)} ${await res.text()}`);
  return String(((await res.json()) as Json).id);
}
const itemsOf = async (id: string) =>
  (await s.db.query<{ items: StoredItem[] }>("select items from plans where id = $1", [id]))[0]?.items ?? [];
async function run(id: string, r = routes): Promise<{ res: Response; executionId?: string }> {
  const res = await r.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
  if (res.status !== 202) return { res };
  const { executionId } = (await res.clone().json()) as { executionId: string };
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
  await svc.background.idle();
  return { res, executionId };
}
const withAccount = (b: MockBroker, marginMode: "HEDGING" | "NETTING"): BrokerProvider =>
  new Proxy(b, {
    get(t, prop, recv) {
      if (prop === "getAccount") return async () => ({ ...(await t.getAccount()), marginMode });
      const v: unknown = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

describe("OD1 market batch: preview → execute", () => {
  it("preview stores exact tagged orders; execute opens exactly them, each with its stop", async () => {
    const res = await preview(MARKET);
    expect(res.status).toBe(201);
    const summary = (await res.json()) as Json;
    expect(summary).toMatchObject({
      action: "market",
      symbol: "EURUSD",
      count: 3,
      breakdown: { buys: 3, sells: 0, totalLots: 0.15 },
    });
    const id = String(summary.id);
    const items = await itemsOf(id);
    const magic = (items[0] as { magic: number }).magic;
    expect(Math.floor(magic / 1e9)).toBe(7731);
    expect(items.map((i) => (i as { clientId: string }).clientId)).toEqual(
      ["0", "1", "2"].map((n) => `${(magic % 1e9).toString(36)}${n}`),
    );

    const before = (await broker.getPositions()).length;
    const { executionId } = await run(id);
    const opened = (await broker.getPositions()).filter((p) => p.magic === magic);
    expect(opened).toHaveLength(3);
    expect(opened.every((p) => p.sl !== null && p.tp !== null)).toBe(true);
    expect((await broker.getPositions()).length).toBe(before + 3);
    const states = await s.db.query<{ state: string }>(
      "select state from execution_items where execution_id = $1",
      [executionId],
    );
    expect(states.map((r) => r.state)).toEqual(["done", "done", "done"]);
  });

  it("every preview gets its own batch number (R9.1): batches never share a magic or a clientId", async () => {
    const a = (await itemsOf(await planId(MARKET)))[0] as { magic: number; clientId: string };
    const b = (await itemsOf(await planId(MARKET)))[0] as { magic: number; clientId: string };
    expect(a.magic).not.toBe(b.magic);
    expect(a.clientId).not.toBe(b.clientId);
  });

  it("an SL inside the spread is refused at preview with the reason; nothing stored", async () => {
    const res = await preview({ ...MARKET, stopLoss: { kind: "points", value: 5 } });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/SL must be below/);
  });

  it("§7 at execute: price moved so the stop is now invalid → PRICE_MOVED, zero broker calls", async () => {
    const id = await planId(MARKET);
    broker.setQuote("EURUSD", 1.0844, 1.0845); // bid now below the buy SL (ask 1.08611 − 150 pts)
    const calls = broker.calls.length;
    const { res } = await run(id);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("PRICE_MOVED");
    expect(broker.calls.length).toBe(calls);
  });

  it("kill switch blocks entries (non-negotiable 3)", async () => {
    const id = await planId(MARKET);
    await setKillSwitch(s.deps, true, s.owner);
    const { res } = await run(id);
    expect((await errorOf(res)).code).toBe("TRADING_HALTED");
  });

  it("R0.2: a netting account can't take batches", async () => {
    const netting = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: withAccount(broker, "NETTING") }),
    );
    const res = await preview(MARKET, netting);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/hedging account/);
  });

  it("caps come from Settings: a lower max orders per action refuses the batch", async () => {
    const settings = makeSettingsRoutes(s.guard, () => svc.capCeilings);
    await settings.capsSet(post("/api/settings/caps", { maxOrdersPerAction: 2 }, s.cookie));
    const res = await preview(MARKET);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe("3 orders is over your cap of 2 per action.");
  });

  it("retry-failed never re-fires entries", async () => {
    const { executionId } = await run(await planId(MARKET));
    await s.db.query("update execution_items set state = 'failed' where execution_id = $1", [executionId]);
    const res = await routes.retryFailed(
      post(`/api/executions/${String(executionId)}/retry-failed`, {}, s.cookie),
      String(executionId),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/aren't retried automatically/);
  });
});

describe("OD2 ladder: preview → execute", () => {
  it("places exactly the previewed pending orders with their stops", async () => {
    const id = await planId(LADDER);
    const items = await itemsOf(id);
    expect(items.map((i) => (i as { openPrice: number }).openPrice)).toEqual([1.085, 1.084, 1.083]);
    await run(id);
    const magic = (items[0] as { magic: number }).magic;
    const orders = (await broker.getOrders()).filter((o) => o.magic === magic);
    expect(orders.map((o) => [o.type, o.openPrice, o.sl])).toEqual([
      ["BUY_LIMIT", 1.085, 1.083],
      ["BUY_LIMIT", 1.084, 1.082],
      ["BUY_LIMIT", 1.083, 1.081],
    ]);
  });

  it("a level now on the wrong side of the market at execute refuses the whole ladder", async () => {
    const id = await planId(LADDER);
    broker.setQuote("EURUSD", 1.0838, 1.0839); // ask fell below the top two buy limits
    const { res } = await run(id);
    expect(res.status).toBe(409);
    const e = (await res.json()) as { error: { code: string; details: unknown[] } };
    expect(e.error.code).toBe("PRICE_MOVED");
    expect(e.error.details).toHaveLength(2);
  });
});
