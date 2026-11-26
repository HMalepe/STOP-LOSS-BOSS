import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import { decodeMagic } from "@/domain/batch";
import { auditKey, verifyChain } from "@/server/audit/audit";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
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
const create = (body: unknown) => routes.createPlan(post("/api/plans", body, s.cookie));
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;
const withMargin = (fn: BrokerProvider["calculateMargin"]): BrokerProvider =>
  new Proxy(broker, {
    get(t, prop, recv) {
      if (prop === "calculateMargin") return fn;
      const v: unknown = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

describe("POST /api/plans: market batches", () => {
  it("a dry run: 201 with risk, margin, spread, batch number; the exact items stored; nothing sent; audited", async () => {
    const res = await create(market());
    expect(res.status).toBe(201);
    const p = (await res.json()) as Json & { entry: Json; id: string };
    expect(p).toMatchObject({
      action: "market",
      symbol: "XAUUSD",
      count: 5,
      breakdown: { buys: 5, sells: 0, totalLots: 0.5 },
    });
    // 500 ticks × $1 × 0.1 lots = $50 per order, $250 total
    expect(p.entry).toMatchObject({
      kind: "market",
      side: "BUY",
      totalLots: 0.5,
      risk: { total: 250, unlimited: false },
      batchSeq: 1,
    });
    expect((p.entry.margin as { required: number }).required).toBeGreaterThan(0);
    expect(p.entry.spread).toMatchObject({ nowPoints: 20 });
    expect(broker.calls).toEqual([]);

    const [row] = await s.db.query<{
      batch_seq: string;
      items: { op: string; sl: number }[];
      action: string;
    }>("select batch_seq, items, action from plans where id = $1", [p.id]);
    expect([
      Number(row?.batch_seq),
      row?.action,
      row?.items.length,
      row?.items.every((i) => i.op === "market" && i.sl > 0),
    ]).toEqual([1, "market", 5, true]);
    const log = await s.db.query<{ action: string; details: Json }>(
      "select action, details from audit_log order by id desc limit 1",
    );
    expect(log[0]).toMatchObject({
      action: "plan.created",
      details: { action: "market", batchSeq: 1, totalLots: 0.5, risk: 250 },
    });
    expect((await verifyChain(s.db, auditKey(s.deps.sessionSecret))).ok).toBe(true);
    const stored = (await (await routes.getPlan(get(`/api/plans/${p.id}`, s.cookie), p.id)).json()) as Json;
    expect((stored.items as unknown[]).length).toBe(5);
  });

  it("each plan gets the next batch number (the database sequence); the magic decodes back to it", async () => {
    const a = (await (await create(market())).json()) as { entry: { batchSeq: number } };
    const b = (await (await create(ladder())).json()) as { entry: { batchSeq: number } };
    expect([a.entry.batchSeq, b.entry.batchSeq]).toEqual([1, 2]);
    expect(decodeMagic(7731 * 1e9 + b.entry.batchSeq, 7731)).toEqual({ app: true, batchSeq: 2 });
  });

  it("a stop too close to the market → 422 PLAN_INVALID with the rule and boundary, nothing stored", async () => {
    const res = await create(market({ sl: { mode: "points", points: 1 } }));
    const e = await errorOf(res);
    expect([res.status, e.code]).toEqual([422, "PLAN_INVALID"]);
    expect((e.details as { rule: string }[])[0]?.rule).toBe("R2.1");
    expect(await s.db.query("select id from plans")).toEqual([]);
  });

  it("R5.2 caps and R9.2a risk cap → 422 saying which", async () => {
    expect((await errorOf(await create(market({ count: 101 })))).message).toBe(
      "Over the safety limits for one action.",
    );
    const risky = await errorOf(
      await create(market({ count: 50, volume: 1, sl: { mode: "points", points: 500 } })),
    );
    expect(risky.code).toBe("PLAN_INVALID");
    expect(JSON.stringify(risky.details)).toMatch(/R5\.2|R9\.2a/);
  });

  it("R9.2b: no SL without an explicit noStop → 400; with it, 201 and the risk is unlimited", async () => {
    const noSl: Json = market();
    delete noSl.sl;
    expect((await errorOf(await create(noSl))).message).toMatch(/Add a stop loss/);
    const ok = await create({ ...noSl, noStop: true });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { entry: { risk: Json } }).entry.risk).toMatchObject({
      unlimited: true,
      total: null,
    });
  });
});

describe("R9.3 margin", () => {
  it("needs more than the account has free → 422 naming both numbers", async () => {
    const res = await create(market({ count: 100, volume: 0.5, sl: undefined, noStop: true })); // 50 lots ≈ $29k margin, no stop so the risk cap does not apply
    const e = await errorOf(res);
    expect([res.status, e.code]).toEqual([422, "PLAN_INVALID"]);
    expect(e.message).toMatch(/needs .* margin; you have .* free/);
  });
  it("the broker can't compute it → blocked as BROKER_UNAVAILABLE, never an estimate", async () => {
    const r = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, broker: withMargin(() => Promise.resolve(undefined)) }),
    );
    const res = await r.createPlan(post("/api/plans", market(), s.cookie));
    const e = await errorOf(res);
    expect([res.status, e.code, e.message]).toEqual([
      503,
      "BROKER_UNAVAILABLE",
      "Can't verify the margin for this batch, so it's blocked.",
    ]);
    expect(await s.db.query("select id from plans")).toEqual([]);
  });
  it("asks the broker at most twice: existing+new and existing-only (and only once when nothing is open)", async () => {
    const asked: number[] = [];
    const spy = withMargin((q) => {
      asked.push(q.volume);
      return broker.calculateMargin(q);
    });
    const r = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: spy }));
    await r.createPlan(post("/api/plans", market(), s.cookie));
    expect(Math.max(...asked)).toBeCloseTo(Math.min(...asked) + 0.5, 8); // existing 0.5 on gold (3 buys + 2 sells = 0.5 lots)
    asked.length = 0;
    await r.createPlan(
      post(
        "/api/plans",
        market({
          symbol: "EURUSD",
          sl: { mode: "points", points: 300 },
          tp: { mode: "points", points: 600 },
        }),
        s.cookie,
      ),
    );
    expect(asked.length).toBe(2); // EURUSD has an open position too (0.5 lots)
  });
});

describe("POST /api/plans: ladders", () => {
  it("a ladder: levels, scaled lots, per-level stops, expiry, requested vs actual, batch number", async () => {
    const res = await create(ladder({ lots: { kind: "scaled", start: 0.1, end: 0.3 } }));
    expect(res.status).toBe(201);
    const p = (await res.json()) as {
      breakdown: { prices: number[]; totalLots: number };
      entry: Json;
      count: number;
    };
    expect(p.breakdown.prices).toEqual([2640, 2630, 2620, 2610, 2600]);
    expect(p).toMatchObject({ count: 5, breakdown: { totalLots: 1 } });
    expect(p.entry).toMatchObject({
      kind: "ladder",
      expiry: { type: "DAY" },
      requestedLevels: 5,
      duplicatesRemoved: 0,
    });
  });
  it("GTC is allowed but flagged; levels on the wrong side of the market are refused, listed", async () => {
    const g = (await (await create(ladder({ expiry: { type: "GTC" } }))).json()) as { warnings: string[] };
    expect(g.warnings.some((w) => w.startsWith("Good-till-cancelled"))).toBe(true);
    const e = await errorOf(await create(ladder({ from: 2660, to: 2655 }))); // above the ask for a Buy Limit
    expect(e.code).toBe("PLAN_INVALID");
    expect(JSON.stringify(e.details)).toMatch(/R5\.5/);
  });
  it("bad bodies → 400 with the field", async () => {
    for (const [b, m] of [
      [ladder({ expiry: undefined }), /^expiry:/],
      [ladder({ spacing: { kind: "levels", levels: 0 } }), /^spacing/],
      [ladder({ type: "BUY_MARKET" }), /^type:/],
      [market({ count: 0 }), /^count:/],
      [market({ side: "LONG" }), /^side:/],
      [market({ extra: 1 }), /extra|body/],
    ] as const) {
      const e = await errorOf(await create(b));
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(m);
    }
  });
});

describe("R7.2, R0.2, gates at preview", () => {
  it("netting account → refused with the reason; a stale quote → 409 PRICE_STALE", async () => {
    const netting: BrokerProvider = new Proxy(broker, {
      get(t, prop, recv) {
        if (prop === "getAccount") {
          return async () => ({ ...(await t.getAccount()), marginMode: "NETTING" as const });
        }
        const v: unknown = Reflect.get(t, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const n = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: netting }));
    expect((await errorOf(await n.createPlan(post("/api/plans", market(), s.cookie)))).message).toMatch(
      /netting/,
    );
    const stale: BrokerProvider = new Proxy(broker, {
      get(t, prop, recv) {
        if (prop === "getQuote") {
          return async (x: string) => ({ ...(await t.getQuote(x)), time: s.clock.now() - 3_001 });
        }
        const v: unknown = Reflect.get(t, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const st = makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: stale }));
    const res = await st.createPlan(post("/api/plans", market(), s.cookie));
    expect([res.status, (await errorOf(res)).code]).toEqual([409, "PRICE_STALE"]);
  });
  it("the spread is recorded and shown: 'spread now X pts'; too few samples says the guard is off", async () => {
    const p = (await (await create(market())).json()) as { warnings: string[]; entry: { spread: Json } };
    expect(p.entry.spread).toEqual({ nowPoints: 20, normalPoints: null });
    expect(p.warnings.some((w) => w.includes("spread guard is off for this batch"))).toBe(true);
  });
});
