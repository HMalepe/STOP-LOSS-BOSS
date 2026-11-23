/**
 * Caps (docs/05, OD7): DB config, re-auth to change. Env values are hard ceilings: the phone can lower a cap and raise it
 * back up to the ceiling, never past it, so a stolen session plus a TOTP code still can't exceed what was deployed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@/server/auth/login";
import { effectiveCaps, type Caps } from "@/server/caps";
import { makeSettingsRoutes } from "@/server/http/settingsRoutes";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { get, post, signedIn, type SignedIn } from "../helpers/session";

const CEILINGS: Caps = {
  maxOrdersPerAction: 100,
  maxTotalLots: 5,
  maxRiskPct: 2,
  maxPositionsPerBatch: 1_000,
};

let s: SignedIn;
let routes: ReturnType<typeof makeSettingsRoutes>;
beforeEach(async () => {
  s = await signedIn();
  routes = makeSettingsRoutes(s.guard, () => CEILINGS);
});
afterEach(async () => {
  await s.db.close();
});

type Json = Record<string, unknown>;
const set = (body: unknown) => routes.capsSet(post("/api/settings/caps", body, s.cookie));
const errorOf = async (r: Response) =>
  ((await r.json()) as { error: { code: string; message: string } }).error;

describe("GET /api/settings/caps", () => {
  it("defaults to the ceilings; says which are which", async () => {
    const res = await routes.capsGet(get("/api/settings/caps", s.cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caps: CEILINGS, ceilings: CEILINGS });
  });
});

describe("POST /api/settings/caps", () => {
  it("needs a fresh re-auth (5 min); nothing changes without it", async () => {
    s.clock.advance(LIMITS.reauthWindowMs + 1);
    const res = await set({ maxTotalLots: 1 });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("REAUTH_REQUIRED");
    expect(await effectiveCaps(s.db, CEILINGS)).toEqual(CEILINGS);
  });

  it("partial update keeps the other caps; change and audit row commit together with before/after", async () => {
    const res = await set({ maxTotalLots: 1.5, maxPositionsPerBatch: 50 });
    expect(res.status).toBe(200);
    const want = { ...CEILINGS, maxTotalLots: 1.5, maxPositionsPerBatch: 50 };
    expect(await res.json()).toEqual({ caps: want, ceilings: CEILINGS });
    await set({ maxRiskPct: 1 });
    expect(await effectiveCaps(s.db, CEILINGS)).toEqual({ ...want, maxRiskPct: 1 });
    const audits = await s.db.query<{ details: Json }>(
      "select details from audit_log where action = 'caps.changed' order by id",
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]?.details).toEqual({ before: CEILINGS, after: want });
  });

  it("can't exceed the server's ceiling; says which env var sets it", async () => {
    const res = await set({ maxTotalLots: 5.01 });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toBe(
      "maxTotalLots can be at most 5 (the server's MAX_TOTAL_LOTS). Nothing was changed.",
    );
  });

  it("rejects nonsense: empty, unknown keys, non-integers, lots off the 0.01 grid, zero", async () => {
    for (const body of [
      {},
      { maxLots: 1 },
      { maxOrdersPerAction: 1.5 },
      { maxTotalLots: 0.015 },
      { maxPositionsPerBatch: 0 },
      { maxRiskPct: -1 },
      { maxTotalLots: "1" },
    ]) {
      expect((await set(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await effectiveCaps(s.db, CEILINGS)).toEqual(CEILINGS);
  });

  it("a lower ceiling after a redeploy wins over a stored value", async () => {
    await set({ maxPositionsPerBatch: 800 });
    expect((await effectiveCaps(s.db, { ...CEILINGS, maxPositionsPerBatch: 300 })).maxPositionsPerBatch).toBe(
      300,
    );
  });
});

describe("previews use the stored cap", () => {
  it("max positions per batch set in settings is enforced on the next preview", async () => {
    const { svc } = mockServices(s.db, s.clock);
    const trading = makeTradingRoutes(s.guard, () => Promise.resolve<TradingServices>(svc));
    await set({ maxPositionsPerBatch: 2 });
    const res = await trading.createPlan(
      post(
        "/api/plans",
        { action: "levels", filter: { symbol: "XAUUSD", side: "BUY" }, takeProfit: 2700 },
        s.cookie,
      ),
    );
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toMatch(/at most 2\. .*Settings/);
  });
});
