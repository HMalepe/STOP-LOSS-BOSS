/** Phase 08 M4: presets (OD3, OD4, R9.6). A preset is a recipe; firing builds a FRESH plan through the normal path. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockBroker } from "@/broker/MockBroker";
import { planSummary } from "@/server/http/contract";
import { makePresetRoutes } from "@/server/http/presetRoutes";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import type { StoredItem } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { get, post, send, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let svc: TradingServices;
let broker: MockBroker;
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
const SCALP = {
  action: "market",
  symbol: "EURUSD",
  side: "BUY",
  count: 10,
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
const create = (body: Json) => presets.create(post("/api/presets", body, s.cookie));
const list = async () =>
  ((await (await presets.list(get("/api/presets", s.cookie))).json()) as { presets: Json[] }).presets;
const errorOf = async (r: Response) =>
  ((await r.json()) as { error: { code: string; message: string } }).error;
async function made(name = "Scalp 10", recipe: Json = SCALP): Promise<string> {
  s.clock.advance(2_000); // a person does not save 50 presets inside one rate-limit window
  const res = await create({ name, recipe });
  if (res.status !== 201) throw new Error(`create ${String(res.status)} ${await res.text()}`);
  return String(((await res.json()) as Json).id);
}
const fire = (id: string) => presets.fire(post(`/api/presets/${id}/fire`, {}, s.cookie), id);
const audits = (action: string) =>
  s.db.query<{ subject: string; details: Json }>(
    "select subject, details from audit_log where action = $1 order by id",
    [action],
  );

describe("CRUD", () => {
  it("create → list (newest last, pinned first) → update → delete, each audited", async () => {
    const a = await made("Scalp 10");
    const b = await made("Ladder 3", LADDER);
    expect((await list()).map((p) => p.name)).toEqual(["Scalp 10", "Ladder 3"]);
    const pin = await presets.update(
      send("PUT", `/api/presets/${b}`, { pinned: true, name: "Ladder three" }, s.cookie),
      b,
    );
    expect(pin.status).toBe(200);
    expect((await list()).map((p) => [p.name, p.pinned])).toEqual([
      ["Ladder three", true],
      ["Scalp 10", false],
    ]);
    expect((await presets.remove(send("DELETE", `/api/presets/${a}`, {}, s.cookie), a)).status).toBe(200);
    expect((await list()).map((p) => p.name)).toEqual(["Ladder three"]);
    expect((await audits("preset.created")).map((r) => r.subject)).toEqual([a, b]);
    expect((await audits("preset.updated")).map((r) => r.subject)).toEqual([b]);
    expect((await audits("preset.deleted")).map((r) => r.subject)).toEqual([a]);
  });

  it("R9.6: an absolute-price preset is flagged: ladders always, market batches with a price SL/TP", async () => {
    await made("Points", SCALP);
    await made("Ladder", LADDER);
    await made("Price SL", { ...SCALP, stopLoss: { kind: "price", value: 1.08 } });
    expect((await list()).map((p) => [p.name, p.absolutePrices])).toEqual([
      ["Points", false],
      ["Ladder", true],
      ["Price SL", true],
    ]);
  });

  it("validation: name, shape, unknown keys, duplicates (case-insensitive), the 50-preset cap", async () => {
    for (const body of [
      {},
      { name: "", recipe: SCALP },
      { name: "x".repeat(41), recipe: SCALP },
      { name: "ok", recipe: { ...SCALP, action: "levels" } },
      { name: "ok", recipe: { ...SCALP, surprise: 1 } },
      { name: "ok", recipe: SCALP, extra: true },
    ]) {
      expect((await create(body)).status, JSON.stringify(body)).toBe(400);
    }
    await made("Scalp");
    const dup = await create({ name: "  sCaLp ", recipe: SCALP });
    expect(dup.status).toBe(400);
    expect((await errorOf(dup)).message).toBe('A preset named "sCaLp" already exists.');
    for (let i = 1; i < 50; i++) await made(`P${String(i)}`);
    const over = await create({ name: "one too many", recipe: SCALP });
    expect(over.status).toBe(400);
    expect((await errorOf(over)).message).toBe("You can keep at most 50 presets.");
  });

  it("update: unknown id 404, empty patch 400, renaming onto another preset's name 400, bad recipe 400", async () => {
    const a = await made("A");
    await made("B");
    const put = (id: string, body: Json) =>
      presets.update(send("PUT", `/api/presets/${id}`, body, s.cookie), id);
    expect((await put(randomUUID(), { name: "x" })).status).toBe(404);
    expect((await put("not-a-uuid", { name: "x" })).status).toBe(404);
    expect((await put(a, {})).status).toBe(400);
    expect((await put(a, { name: "b" })).status).toBe(400);
    expect((await put(a, { recipe: { action: "ladder" } })).status).toBe(400);
    expect((await put(a, { name: "A" })).status).toBe(200); // keeping its own name is fine
  });

  it("reorder: must list every preset exactly once; the new order sticks (pinned still first)", async () => {
    const [a, b, c] = [await made("A"), await made("B"), await made("C")] as [string, string, string];
    const order = (ids: string[]) => presets.reorder(send("PUT", "/api/presets/order", { ids }, s.cookie));
    expect((await order([a, b])).status).toBe(400);
    expect((await order([a, a, b])).status).toBe(400);
    expect((await order([a, b, randomUUID()])).status).toBe(400);
    expect((await order([c, a, b])).status).toBe(200);
    expect((await list()).map((p) => p.name)).toEqual(["C", "A", "B"]);
  });

  it("owner only: another user's preset is invisible and untouchable; no session → 401", async () => {
    const other = randomUUID();
    await s.db.query("insert into users (id, password_hash, totp_secret_enc) values ($1, 'x', 'x')", [other]);
    const [{ id }] = (await s.db.query<{ id: string }>(
      "insert into presets (user_id, name, recipe) values ($1, 'theirs', $2::jsonb) returning id",
      [other, JSON.stringify(SCALP)],
    )) as [{ id: string }];
    expect(await list()).toEqual([]);
    expect(
      (await presets.update(send("PUT", `/api/presets/${id}`, { name: "mine" }, s.cookie), id)).status,
    ).toBe(404);
    expect((await presets.remove(send("DELETE", `/api/presets/${id}`, {}, s.cookie), id)).status).toBe(404);
    expect((await fire(id)).status).toBe(404);
    expect((await presets.list(get("/api/presets"))).status).toBe(401);
  });
});

describe("firing (R9.6, R9.7): a fresh plan through the normal path", () => {
  it("fire → a stored, previewable plan (same response as POST /api/plans); the batch executes like any other", async () => {
    const id = await made();
    const res = await fire(id);
    expect(res.status).toBe(201);
    const summary = planSummary.parse(await res.json());
    expect(summary).toMatchObject({ action: "market", symbol: "EURUSD", count: 10 });
    expect(summary.risk?.toStop).toBeGreaterThan(0);
    const run = await trading.execute(post(`/api/plans/${summary.id}/execute`, {}, s.cookie), summary.id);
    expect(run.status).toBe(202);
    expect((await audits("plan.created")).some((r) => r.details.presetId === id)).toBe(true);
  });

  it("every fire is a NEW batch (own magic and ids), never a replay of the last one", async () => {
    const id = await made();
    const a = planSummary.parse(await (await fire(id)).json());
    const b = planSummary.parse(await (await fire(id)).json());
    const items = async (planId: string) =>
      (await s.db.query<{ items: StoredItem[] }>("select items from plans where id = $1", [planId]))[0]!
        .items as { magic: number; clientId: string }[];
    const [ia, ib] = [await items(a.id), await items(b.id)];
    expect(ia[0]!.magic).not.toBe(ib[0]!.magic);
    expect(ia[0]!.clientId).not.toBe(ib[0]!.clientId);
  });

  it("a points preset is built from the LIVE price at fire time, not the price when it was saved", async () => {
    const id = await made();
    const slAt = async () => {
      const r = planSummary.parse(await (await fire(id)).json());
      const [row] = await s.db.query<{ items: { sl: number }[] }>("select items from plans where id = $1", [
        r.id,
      ]);
      return row!.items[0]!.sl;
    };
    const before = await slAt();
    broker.setQuote("EURUSD", 1.1, 1.1001);
    expect(await slAt()).toBeCloseTo(before + (1.1001 - 1.0861), 4);
  });

  it("an absolute-price ladder whose levels are no longer valid is refused with the levels listed, nothing stored", async () => {
    const id = await made("Ladder", LADDER);
    broker.setQuote("EURUSD", 1.0838, 1.0839); // ask fell below the top two buy limits
    const res = await fire(id);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/2 of 3 levels can't be placed/);
    expect(await s.db.query("select id from plans")).toEqual([]);
  });

  it("every check a manual batch gets still applies: over the risk cap is refused, a recipe that no longer parses is a 400", async () => {
    const big = await made("Big", {
      ...SCALP,
      count: 20,
      volume: 0.25,
      stopLoss: { kind: "points", value: 1000 },
    });
    const res = await fire(big);
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/over your cap of 2% of equity/);
    const old = await made("Old");
    await s.db.query("update presets set recipe = $2::jsonb where id = $1", [
      old,
      JSON.stringify({ action: "market", symbol: "EURUSD" }),
    ]);
    const stale = await fire(old);
    expect(stale.status).toBe(400);
    expect((await errorOf(stale)).message).toMatch(/no longer valid/);
  });
});
