import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import type { PlanItem } from "@/domain/types";
import { auditKey, verifyChain } from "@/server/audit/audit";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { itemsHash, PLAN_TTL_MS } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
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

const create = (body: unknown) => routes.createPlan(post("/api/plans", body, s.cookie));
const gold = (side: "ALL" | "BUY" | "SELL" = "BUY") => ({ symbol: "XAUUSD", side });
type Json = Record<string, unknown>;

describe("POST /api/plans", () => {
  it("a dry run: 201 PlanSummary, stored with its exact items and their hash, audited; nothing sent", async () => {
    broker.seedPosition({
      symbol: "XAUUSD",
      side: "BUY",
      volume: 0.2,
      openPrice: 2640,
      sl: null,
      tp: 2700,
      magic: 0,
    });
    const res = await create({ action: "levels", filter: gold(), stopLoss: 2600 });
    expect(res.status).toBe(201);
    const summary = (await res.json()) as Json;
    expect(summary).toMatchObject({
      action: "levels",
      symbol: "XAUUSD",
      count: 4,
      mode: "mock",
      quote: { bid: 2650.1, ask: 2650.3 },
      breakdown: { buys: 4, sells: 0 },
      skipped: [],
      expiresAt: new Date(s.clock.now() + PLAN_TTL_MS).toISOString(),
    });

    const stored = (await (
      await routes.getPlan(get(`/api/plans/${String(summary.id)}`, s.cookie), String(summary.id))
    ).json()) as Json & {
      items: PlanItem[];
    };
    expect(stored).toMatchObject({ ...summary, status: "created" });
    // R2.7: the TP the owner didn't touch rides along unchanged.
    expect(stored.items.find((i) => i.op === "modify" && i.tp === 2700)).toBeDefined();
    const [row] = await s.db.query<{ input_hash: string }>("select input_hash from plans");
    expect(row?.input_hash).toBe(itemsHash(stored.items));
    expect(broker.calls).toEqual([]);
    const actions = await s.db.query<{ action: string }>("select action from audit_log order by id");
    expect(actions.at(-1)).toEqual({ action: "plan.created" });
    expect((await verifyChain(s.db, auditKey(s.deps.sessionSecret))).ok).toBe(true);
  });

  it("breakeven and lock plans build too (skips are reported, not errors)", async () => {
    const be = (await (
      await create({ action: "breakeven", filter: gold("ALL"), offsetPoints: 10 })
    ).json()) as Json;
    expect(be).toMatchObject({ action: "breakeven" });
    expect(Array.isArray(be.skipped)).toBe(true);
    const lock = await create({ action: "lock", filter: gold("ALL"), distancePoints: 100 });
    expect([201, 422]).toContain(lock.status);
  });

  it("an invalid level → 422 PLAN_INVALID with grouped {side, rule, boundary, message}", async () => {
    const res = await create({ action: "levels", filter: gold("SELL"), stopLoss: 2600 });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: Json[] } };
    expect(body.error.code).toBe("PLAN_INVALID");
    expect(body.error.details[0]).toMatchObject({ side: "SELL", count: 2 });
    expect(body.error.details[0]).toHaveProperty("rule");
    expect(body.error.details[0]).toHaveProperty("boundary");
    expect(body.error.details[0]).toHaveProperty("message");
  });

  it("nothing matches → 422 PLAN_INVALID with empty details", async () => {
    const res = await create({ action: "levels", filter: { symbol: "EURUSD", side: "SELL" }, stopLoss: 1.2 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "PLAN_INVALID", message: "Nothing to do: no open positions match.", details: [] },
    });
  });

  it("R7.2: a quote older than 3 s can't be previewed against → 409 PRICE_STALE", async () => {
    const b = broker;
    const stale: BrokerProvider = {
      name: "mock",
      health: () => b.health(),
      getAccount: () => b.getAccount(),
      getPositions: () => b.getPositions(),
      getOrders: () => b.getOrders(),
      getPositionsForClose: () => b.getPositionsForClose(),
      getOrdersForClose: () => b.getOrdersForClose(),
      getQuote: async (x) => ({ ...(await b.getQuote(x)), time: s.clock.now() - 3_001 }),
      getSymbolSpec: (x) => b.getSymbolSpec(x),
      modifyPosition: (id, l) => b.modifyPosition(id, l),
      closePosition: (id) => b.closePosition(id),
      placeMarket: (r) => b.placeMarket(r),
      placePending: (r) => b.placePending(r),
      cancelOrder: (id) => b.cancelOrder(id),
      reconcile: (ids) => b.reconcile(ids),
      close: () => b.close(),
    };
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: stale }));
    const res = await r.createPlan(
      post("/api/plans", { action: "closeAt", filter: gold(), price: 2700 }, s.cookie),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "PRICE_STALE" } });
  });

  it.each([
    [{ action: "market", symbol: "XAUUSD", side: "BUY", count: 5, volume: 0.1 }, /Order Desk/],
    [{ action: "ladder" }, /Order Desk/],
    [{ action: "cancel", filter: gold() }, /Order Desk/],
    [{ action: "levels", filter: gold() }, /SL, a TP, or both/],
    [{ action: "levels", filter: gold(), stopLoss: -1 }, /^stopLoss:/],
    [{ action: "levels", filter: gold(), stopLoss: 2600, sneaky: true }, /^body:|sneaky/],
    [{ action: "levels", filter: { ...gold(), symbol: "XAU USD" }, stopLoss: 1 }, /^filter\.symbol:/],
    [{ action: "lock", filter: gold(), distancePoints: 0 }, /^distancePoints:/],
    [{ action: "breakeven", filter: gold(), offsetPoints: 1.5 }, /^offsetPoints:/],
    [{ action: "nope" }, /action/],
    ["not json", /JSON/],
  ])("bad body %j → 400 VALIDATION", async (body, message) => {
    const res =
      typeof body === "string"
        ? await routes.createPlan(
            new Request("https://desk.example.com/api/plans", {
              method: "POST",
              headers: { origin: "https://desk.example.com", cookie: s.cookie },
              body,
            }),
          )
        : await create(body);
    expect(res.status).toBe(400);
    const e = (await res.json()) as { error: { code: string; message: string } };
    expect(e.error.code).toBe("VALIDATION");
    expect(e.error.message).toMatch(message);
  });

  it("broker down → 503, no plan stored", async () => {
    broker.setConnected(false);
    expect((await create({ action: "closeAt", filter: gold(), price: 2700 })).status).toBe(503);
    expect(await s.db.query("select id from plans")).toEqual([]);
  });

  it("needs a session", async () => {
    expect(
      (await routes.createPlan(post("/api/plans", { action: "closeAt", filter: gold(), price: 2700 })))
        .status,
    ).toBe(401);
  });
});

describe("GET /api/plans/:id", () => {
  it("expired after 30 s; unknown, malformed or someone else's → 404", async () => {
    const summary = (await (
      await create({ action: "closeAt", filter: gold("ALL"), price: 2700 })
    ).json()) as Json;
    const id = String(summary.id);
    s.clock.advance(PLAN_TTL_MS);
    expect(await (await routes.getPlan(get(`/api/plans/${id}`, s.cookie), id)).json()).toMatchObject({
      status: "expired",
    });
    expect((await routes.getPlan(get("/api/plans/x", s.cookie), "x")).status).toBe(404);
    const other = "00000000-0000-4000-8000-000000000000";
    expect((await routes.getPlan(get(`/api/plans/${other}`, s.cookie), other)).status).toBe(404);
    await s.db.query("insert into users (id, password_hash, totp_secret_enc) values ($1, 'x', 'y')", [other]);
    await s.db.query("update plans set user_id = $1", [other]);
    expect((await routes.getPlan(get(`/api/plans/${id}`, s.cookie), id)).status).toBe(404);
    expect((await routes.getPlan(get(`/api/plans/${id}`), id)).status).toBe(401);
  });
});
