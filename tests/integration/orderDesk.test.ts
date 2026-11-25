/** Phase 08 M3a: Order Desk entries through the real routes, runner, database and mock broker. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import { setKillSwitch } from "@/server/killSwitch";
import { planSummary } from "@/server/http/contract";
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
const override = (b: MockBroker, over: Partial<BrokerProvider>): BrokerProvider =>
  new Proxy(b, {
    get(t, prop, recv) {
      if (prop in over) return over[prop as keyof BrokerProvider];
      const v: unknown = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
const routesWith = (over: Partial<BrokerProvider>) =>
  makeTradingRoutes(s.guard, () => Promise.resolve({ ...svc, broker: override(broker, over) }));
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
      ["000", "001", "002"].map((n) => `${(magic % 1e9).toString(36)}${n}`),
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

describe("M3b: risk to SL and margin, before anything is stored (OD6, R9.2, R9.3)", () => {
  it("the preview shows money at risk, % of equity, the cap, margin required and free margin; matches the contract", async () => {
    const res = await preview(MARKET);
    const summary = planSummary.parse(await res.json());
    // EURUSD tick value 1/lot: 150 pts × 1 × 0.05 lot × 3 orders = 22.50, as a % of the live equity.
    const { equity, freeMargin } = await broker.getAccount();
    expect(summary.risk).toMatchObject({
      currency: "USD",
      toStop: 22.5,
      pctOfEquity: Math.round((22.5 / equity) * 10_000) / 100,
      capPct: 2,
      freeMargin,
    });
    expect(summary.risk?.marginRequired).toBeGreaterThan(0);
  });

  it("no SL without saying so → refused; with noStop it's allowed: unbounded risk shown as null + the warning, margin still checked", async () => {
    const silent = await preview({ ...MARKET, stopLoss: undefined });
    expect(silent.status).toBe(422);
    expect((await errorOf(silent)).message).toBe(
      'This batch has no stop loss. Add one, or choose "no stop" on purpose.',
    );
    const res = await preview({ ...MARKET, stopLoss: undefined, noStop: true });
    expect(res.status).toBe(201);
    const summary = planSummary.parse(await res.json());
    expect(summary.risk).toMatchObject({ toStop: null, pctOfEquity: null, capPct: 2 });
    expect(summary.risk?.marginRequired).toBeGreaterThan(0);
    expect(summary.warnings).toContain(
      "No stop loss: the loss on these orders is limited only by your account.",
    );
    const big = await preview(
      { ...MARKET, stopLoss: undefined, noStop: true },
      routesWith({ calculateMargin: (o) => Promise.resolve(o.volume > 0.5 ? 1_000_000 : 0) }),
    );
    expect((await errorOf(big)).message).toMatch(/needs .* margin; you have .* free/);
  });

  it("noStop together with a stop loss is a contradiction → 400, for batches and ladders", async () => {
    expect((await preview({ ...MARKET, noStop: true })).status).toBe(400);
    expect((await preview({ ...LADDER, noStop: true })).status).toBe(400);
    expect((await preview({ ...LADDER, slOffsetPoints: undefined })).status).toBe(422);
    expect((await preview({ ...LADDER, slOffsetPoints: undefined, noStop: true })).status).toBe(201);
  });

  it("a noStop batch fires and opens orders with no stop (only because it was asked for)", async () => {
    const id = await planId({ ...MARKET, stopLoss: undefined, takeProfit: undefined, noStop: true });
    const { executionId } = await run(id);
    expect(executionId).toBeDefined();
    const magic = ((await itemsOf(id))[0] as { magic: number }).magic;
    const opened = (await broker.getPositions()).filter((p) => p.magic === magic);
    expect(opened).toHaveLength(3);
    expect(opened.every((p) => p.sl === null)).toBe(true);
  });

  it("over the risk cap → refused with the numbers", async () => {
    // 20 × 0.25 lot × 1,000 pts = 5,000 USD, far over 2% of 10,000.
    const res = await preview({
      ...MARKET,
      count: 20,
      volume: 0.25,
      stopLoss: { kind: "points", value: 1000 },
    });
    expect(res.status).toBe(422);
    const cap = (((await broker.getAccount()).equity * 2) / 100).toFixed(2);
    expect((await errorOf(res)).message).toBe(
      `Risk to SL is 5000.00 USD, over your cap of 2% of equity (${cap} USD).`,
    );
  });

  it("margin over free margin → refused; the broker can't compute it → refused, never estimated", async () => {
    const big = await preview(
      MARKET,
      routesWith({ calculateMargin: (o) => Promise.resolve(o.volume > 0.5 ? 1_000_000 : 0) }),
    );
    expect((await errorOf(big)).message).toMatch(/needs .* margin; you have .* free/);
    const unknown = await preview(MARKET, routesWith({ calculateMargin: () => Promise.resolve(null) }));
    expect(unknown.status).toBe(422);
    expect((await errorOf(unknown)).message).toBe("Can't verify the margin for this batch, so it's blocked.");
  });

  it("R9.3: margin is the broker's figure for existing+new minus existing-only, plus 10%: at most 2 calls, any ladder size", async () => {
    const asked: { volume: number; openPrice: number }[] = [];
    const r = routesWith({
      calculateMargin: (o) => {
        asked.push({ volume: o.volume, openPrice: o.openPrice });
        return broker.calculateMargin(o);
      },
    });
    // The demo book already holds 0.5 lot EURUSD, so: (0.5 + 0.15) and 0.5, both priced at the batch's worst price.
    await preview(MARKET, r);
    expect(asked).toEqual([
      { volume: 0.65, openPrice: 1.08611 },
      { volume: 0.5, openPrice: 1.08611 },
    ]);
    asked.length = 0;
    await preview({ ...LADDER, lots: { mode: "scaled", start: 0.1, end: 0.3 } }, r);
    expect(asked).toHaveLength(2); // scaled lots no longer cost a call per level
    expect(asked.map((a) => a.volume)).toEqual([0.5 + 0.1 + 0.2 + 0.3, 0.5]);
    const net =
      ((await broker.calculateMargin({ symbol: "EURUSD", side: "BUY", volume: 1.1, openPrice: 1.085 })) ??
        0) -
      ((await broker.calculateMargin({ symbol: "EURUSD", side: "BUY", volume: 0.5, openPrice: 1.085 })) ?? 0);
    const summary = planSummary.parse(
      await (await preview({ ...LADDER, lots: { mode: "scaled", start: 0.1, end: 0.3 } })).json(),
    );
    expect(summary.risk?.marginRequired).toBeCloseTo(net * 1.1, 1);
  });

  it("R9.3 no stop: the margin level after the batch must stay above 500%; a thinly-margined no-stop batch is refused", async () => {
    const { equity, margin } = await broker.getAccount();
    // Required margin that leaves equity / (used + required) at about 400%.
    const required = equity / 4 - margin;
    const thin = routesWith({
      calculateMargin: (o) => Promise.resolve(o.volume > 0.5 ? required / 1.1 : 0),
    });
    const res = await preview({ ...MARKET, stopLoss: undefined, noStop: true }, thin);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/With no stop the margin level must stay above 500%/);
  });

  it("no tick value from the feed → 503, never a guessed risk", async () => {
    const r = routesWith({
      getQuote: async (x) => {
        const q = await broker.getQuote(x);
        return { symbol: q.symbol, bid: q.bid, ask: q.ask, time: q.time };
      },
    });
    expect((await preview(MARKET, r)).status).toBe(503);
  });
});

describe("M3c: spread guard at fire time (R9.4)", () => {
  /** 30+ normal ticks of 10 points, as the stream would have produced while the owner looked at the preview. */
  const warm = async () => {
    const spec = await broker.getSymbolSpec("EURUSD");
    for (let i = 0; i < 40; i++) {
      svc.spread.record(
        { symbol: "EURUSD", bid: 1.086, ask: 1.0861, time: s.clock.now() - 40_000 + i * 1_000 },
        spec,
      );
    }
  };

  it("preview says spread now vs normal; a cold symbol warns but never blocks", async () => {
    const cold = (await (await preview(MARKET)).json()) as { warnings: string[] };
    expect(cold.warnings).toContain(
      "Not enough recent prices to know the normal spread, so the spread guard is off for this batch.",
    );
    await warm();
    const res = (await (await preview(MARKET)).json()) as { warnings: string[] };
    expect(res.warnings).toContain("Spread now 10 pts, normal 10 pts.");
  });

  it("a spike when firing (news) refuses the whole batch: SPREAD_TOO_WIDE, zero broker calls", async () => {
    await warm();
    const id = await planId(MARKET);
    broker.setQuote("EURUSD", 1.0858, 1.0862); // 40 points wide vs a normal 10; levels still valid
    const calls = broker.calls.length;
    const { res } = await run(id);
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe("SPREAD_TOO_WIDE");
    expect(e.message).toBe(
      "Spread is 40 points; it's normally 10. Refused until it settles. Nothing was sent.",
    );
    expect(broker.calls.length).toBe(calls);
  });

  it("R9.4a absolute max per symbol blocks even without history", async () => {
    const strict = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, spreadGuard: { ...svc.spreadGuard, maxPts: { EURUSD: 5 } } }),
    );
    const id = await planId(MARKET, strict);
    const { res } = await run(id, strict);
    expect((await errorOf(res)).message).toBe("Spread is 10 points; the limit is 5. Nothing was sent.");
  });

  it("a normal spread fires", async () => {
    await warm();
    const { executionId } = await run(await planId(MARKET));
    expect(executionId).toBeDefined();
  });
});

describe("R9.7: free margin is re-read at execute", () => {
  it("margin used elsewhere between preview and fire → MARGIN_INSUFFICIENT, zero broker calls", async () => {
    const id = await planId(MARKET);
    // Someone (or a big position opened by hand) eats the free margin after the preview.
    broker.seedPosition({
      symbol: "EURUSD",
      side: "BUY",
      volume: 80,
      openPrice: 1.086,
      sl: null,
      tp: null,
      magic: 0,
    });
    const calls = broker.calls.length;
    const { res } = await run(id);
    expect(res.status).toBe(409);
    const e = await errorOf(res);
    expect(e.code).toBe("MARGIN_INSUFFICIENT");
    expect(e.message).toMatch(/^Free margin is now .* USD, this batch needs .* USD\. Nothing was sent\./);
    expect(broker.calls.length).toBe(calls);
  });

  it("enough free margin still fires; a plan from before this check (no stored requirement) is not blocked by it", async () => {
    const { executionId } = await run(await planId(MARKET));
    expect(executionId).toBeDefined();
  });
});
