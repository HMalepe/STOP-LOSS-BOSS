import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockBroker } from "@/broker/MockBroker";
import { makePresetRoutes } from "@/server/http/presetRoutes";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { isAbsolute, MAX_PRESETS, resolveRecipe, type Recipe } from "@/server/trading/presets";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { get, post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let broker: MockBroker;
let svc: TradingServices;
let presets: ReturnType<typeof makePresetRoutes>;
let trading: ReturnType<typeof makeTradingRoutes>;

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
  presets = makePresetRoutes(s.guard, () => Promise.resolve(svc));
  trading = makeTradingRoutes(s.guard, () => Promise.resolve(svc));
});
afterEach(async () => {
  await s.db.close();
});

type Json = Record<string, unknown>;
const scalp: Recipe = {
  kind: "market",
  symbol: "XAUUSD",
  side: "BUY",
  count: 5,
  volume: 0.1,
  sl: { mode: "points", points: 500 },
  tp: { mode: "points", points: 1000 },
};
const grid: Recipe = {
  kind: "ladder",
  symbol: "XAUUSD",
  type: "BUY_LIMIT",
  from: { mode: "offset", points: -1000 },
  to: { mode: "offset", points: -4000 },
  spacing: { kind: "levels", levels: 4 },
  lots: { kind: "flat", volume: 0.1 },
  slPoints: 500,
  tpPoints: 1000,
  expiry: { type: "DAY" },
};
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://desk.example.com${path}`, {
    method,
    headers: { origin: "https://desk.example.com", cookie: s.cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const create = (name: string, recipe: Recipe, extra: Json = {}) =>
  presets.create(post("/api/presets", { name, recipe, ...extra }, s.cookie));
const list = async () =>
  (
    (await (await presets.list(get("/api/presets", s.cookie))).json()) as {
      items: { id: string; name: string; pinned: boolean; absolute: boolean }[];
    }
  ).items;
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe("presets CRUD (OD3)", () => {
  it("create → list (pinned first, then order, then name) → update → delete; each audited", async () => {
    const a = (await (await create("Scalp 5", scalp)).json()) as { id: string };
    await create("Grid", grid, { pinned: true });
    await create("Alpha", scalp);
    expect((await list()).map((p) => p.name)).toEqual(["Grid", "Scalp 5", "Alpha"]);
    const up = await presets.update(
      req("PUT", `/api/presets/${a.id}`, { name: "Scalp 5 fast", pinned: true, sort: 0 }),
      a.id,
    );
    expect(up.status).toBe(200);
    expect((await list()).map((p) => p.name)).toEqual(["Scalp 5 fast", "Grid", "Alpha"]);
    expect((await presets.remove(req("DELETE", `/api/presets/${a.id}`), a.id)).status).toBe(200);
    expect((await list()).map((p) => p.name)).toEqual(["Grid", "Alpha"]);
    const log = (
      await s.db.query<{ action: string }>(
        "select action from audit_log where action like 'preset.%' order by id",
      )
    ).map((r) => r.action);
    expect(log).toEqual([
      "preset.created",
      "preset.created",
      "preset.created",
      "preset.updated",
      "preset.deleted",
    ]);
  });

  it("a name is unique per owner, case-insensitively; the 51st preset is refused", async () => {
    await create("Scalp", scalp);
    expect((await errorOf(await create("scalp", grid))).message).toBe(
      "You already have a preset with that name.",
    );
    const b = (await (await create("Other", scalp)).json()) as { id: string };
    expect(
      (await errorOf(await presets.update(req("PUT", `/api/presets/${b.id}`, { name: "SCALP" }), b.id))).code,
    ).toBe("VALIDATION");
    expect((await presets.update(req("PUT", `/api/presets/${b.id}`, { name: "Other" }), b.id)).status).toBe(
      200,
    ); // renaming to itself is fine
    // Fill straight to the limit (the request throttle would, rightly, stop a loop of 50 creates).
    await s.db.query(
      "insert into presets (user_id, name, recipe) select $1, 'filler ' || g, $2::jsonb from generate_series(1, $3::int) g",
      [s.owner.userId, JSON.stringify(scalp), MAX_PRESETS - 2],
    );
    expect((await errorOf(await create("one too many", scalp))).message).toMatch(/limit for saved presets/);
  });

  it("recipes are validated like plan bodies; junk is 400 with the field; unknown or foreign ids are 404", async () => {
    for (const [body, m] of [
      [{ name: "", recipe: scalp }, /^name:/],
      [{ name: "x", recipe: { ...scalp, count: 0 } }, /^recipe/],
      [{ name: "x", recipe: { ...grid, expiry: undefined } }, /^recipe/],
      [{ name: "x", recipe: scalp, extra: 1 }, /extra|body/],
    ] as const) {
      const e = await errorOf(await presets.create(post("/api/presets", body, s.cookie)));
      expect(e.code).toBe("VALIDATION");
      expect(e.message).toMatch(m);
    }
    const none = "00000000-0000-4000-8000-000000000000";
    expect((await presets.update(req("PUT", `/api/presets/${none}`, { pinned: true }), none)).status).toBe(
      404,
    );
    expect((await presets.remove(req("DELETE", `/api/presets/${none}`), none)).status).toBe(404);
    expect((await presets.fire(req("POST", `/api/presets/${none}/fire`, {}), none)).status).toBe(404);
    expect((await presets.remove(req("DELETE", "/api/presets/x"), "x")).status).toBe(404);
  });

  it("only the owner's: another user's preset is invisible and untouchable; no session → 401", async () => {
    const a = (await (await create("Mine", scalp)).json()) as { id: string };
    const other = "00000000-0000-4000-8000-0000000000aa";
    await s.db.query("insert into users (id, password_hash, totp_secret_enc) values ($1, 'x', 'y')", [other]);
    await s.db.query("update presets set user_id = $1", [other]);
    expect(await list()).toEqual([]);
    expect((await presets.update(req("PUT", `/api/presets/${a.id}`, { pinned: true }), a.id)).status).toBe(
      404,
    );
    expect((await presets.list(get("/api/presets"))).status).toBe(401);
  });

  it("absolute prices are flagged; offsets are not (R9.6)", async () => {
    await create("Rel", grid);
    await create("Abs", { ...grid, from: { mode: "price", price: 2640 } });
    await create("AbsMkt", { ...scalp, sl: { mode: "price", price: 2600 } });
    const byName = Object.fromEntries((await list()).map((p) => [p.name, p.absolute]));
    expect(byName).toEqual({ Rel: false, Abs: true, AbsMkt: true });
    expect([isAbsolute(scalp), isAbsolute(grid)]).toEqual([false, false]);
  });

  it("a recipe this version can't read is hidden, never half-run", async () => {
    await create("Good", scalp);
    await s.db.query(
      "insert into presets (user_id, name, recipe) values ($1, 'Future', '{\"kind\":\"iceberg\"}'::jsonb)",
      [s.owner.userId],
    );
    expect((await list()).map((p) => p.name)).toEqual(["Good"]);
  });
});

describe("R9.6 fire builds a FRESH plan from the live quote (OD3/OD4)", () => {
  it("a market preset → a stored plan with its batch number, like a manual preview; nothing is sent; audited with the preset", async () => {
    const p = (await (await create("Scalp 5", scalp)).json()) as { id: string };
    const res = await presets.fire(req("POST", `/api/presets/${p.id}/fire`, {}), p.id);
    expect(res.status).toBe(201);
    const plan = (await res.json()) as {
      id: string;
      action: string;
      count: number;
      entry: { batchSeq: number; risk: { total: number } };
    };
    expect([plan.action, plan.count, plan.entry.batchSeq, plan.entry.risk.total]).toEqual([
      "market",
      5,
      1,
      250,
    ]);
    expect(broker.calls).toEqual([]);
    const log = await s.db.query<{ details: Json }>(
      "select details from audit_log where action = 'plan.created' order by id desc limit 1",
    );
    expect(log[0]?.details).toMatchObject({ preset: "Scalp 5", presetId: p.id, batchSeq: 1 });
  });

  it("a ladder preset's offsets are resolved against the quote AT FIRE TIME: move the market, the ladder moves with it", async () => {
    const p = (await (await create("Grid", grid)).json()) as { id: string };
    const prices = async () =>
      (
        (await (await presets.fire(req("POST", `/api/presets/${p.id}/fire`, {}), p.id)).json()) as {
          breakdown: { prices: number[] };
        }
      ).breakdown.prices;
    expect(await prices()).toEqual([2640.3, 2630.3, 2620.3, 2610.3]); // ask 2650.30 − 1000 … − 4000 points (1 point = 0.01)
    broker.setQuote("XAUUSD", 2600.1, 2600.3);
    expect(await prices()).toEqual([2590.3, 2580.3, 2570.3, 2560.3]);
  });

  it("an absolute-price ladder keeps its prices, and the normal builder re-validates them against the live market", async () => {
    const p = (await (
      await create("Abs", {
        ...grid,
        from: { mode: "price", price: 2640 },
        to: { mode: "price", price: 2610 },
      })
    ).json()) as { id: string };
    expect(
      (
        (await (await presets.fire(req("POST", `/api/presets/${p.id}/fire`, {}), p.id)).json()) as {
          breakdown: { prices: number[] };
        }
      ).breakdown.prices,
    ).toEqual([2640, 2630, 2620, 2610]);
    broker.setQuote("XAUUSD", 2600.1, 2600.3); // those buy-limit levels are now ABOVE the market
    const e = await errorOf(await presets.fire(req("POST", `/api/presets/${p.id}/fire`, {}), p.id));
    expect(e.code).toBe("PLAN_INVALID");
  });

  it("OD4 quick-fire: the side toggle flips a market preset; for a ladder it's refused", async () => {
    const p = (await (await create("Scalp", scalp)).json()) as { id: string };
    const sell = (await (
      await presets.fire(req("POST", `/api/presets/${p.id}/fire`, { side: "SELL" }), p.id)
    ).json()) as { entry: { side: string }; breakdown: { sells: number } };
    expect([sell.entry.side, sell.breakdown.sells]).toEqual(["SELL", 5]);
    const g = (await (await create("Grid", grid)).json()) as { id: string };
    expect(
      (await errorOf(await presets.fire(req("POST", `/api/presets/${g.id}/fire`, { side: "SELL" }), g.id)))
        .message,
    ).toMatch(/only applies to market presets/);
  });

  it("fire refuses what the builders refuse: same errors as a manual preview (caps, stops, broker down)", async () => {
    const big = (await (await create("Big", { ...scalp, count: 100, volume: 5 })).json()) as { id: string };
    expect(
      (await errorOf(await presets.fire(req("POST", `/api/presets/${big.id}/fire`, {}), big.id))).code,
    ).toBe("PLAN_INVALID");
    const ok = (await (await create("Ok", scalp)).json()) as { id: string };
    broker.setConnected(false);
    expect((await presets.fire(req("POST", `/api/presets/${ok.id}/fire`, {}), ok.id)).status).toBe(503);
  });

  it("the fired plan executes through the normal path: preview → confirm → orders carry the batch identity", async () => {
    const p = (await (await create("Scalp 5", scalp)).json()) as { id: string };
    const plan = (await (await presets.fire(req("POST", `/api/presets/${p.id}/fire`, {}), p.id)).json()) as {
      id: string;
    };
    const res = await trading.execute(post(`/api/plans/${plan.id}/execute`, {}, s.cookie), plan.id);
    expect(res.status).toBe(202);
    const { executionId } = (await res.json()) as { executionId: string };
    for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
    expect((await broker.getPositions()).filter((x) => x.comment === "OD:1")).toHaveLength(5);
  });

  it("resolveRecipe is pure: same recipe + same quote = same body", () => {
    const quote = { symbol: "XAUUSD", bid: 2650.1, ask: 2650.3, time: 1 };
    const spec = {
      symbol: "XAUUSD",
      digits: 2,
      point: 0.01,
      tickSize: 0.01,
      stopsLevel: 0,
      freezeLevel: 0,
      volumeMin: 0.01,
      volumeMax: 200,
      volumeStep: 0.01,
    };
    expect(resolveRecipe(grid, quote, spec)).toEqual(resolveRecipe(grid, quote, spec));
    expect(resolveRecipe(grid, quote, spec)).toMatchObject({ action: "ladder", from: 2640.3, to: 2610.3 });
    expect(
      resolveRecipe(
        {
          ...grid,
          type: "SELL_STOP",
          from: { mode: "offset", points: -500 },
          to: { mode: "offset", points: -900 },
        },
        quote,
        spec,
      ),
    ).toMatchObject({ from: 2645.1, to: 2641.1 }); // sell types measure from the BID
  });
});
