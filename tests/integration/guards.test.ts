import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "@/domain/clock";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { LIMITS, passwordStep, secondFactorStep, type AuthDeps } from "@/server/auth/login";
import { createOwner, type OwnerSecrets } from "@/server/auth/owner";
import { totpAt } from "@/server/auth/totp";
import type { Db } from "@/server/db/sql";
import { makeAdminRoutes } from "@/server/http/adminRoutes";
import { makeGuard, originAllowed } from "@/server/http/guard";
import { ok } from "@/server/http/respond";
import {
  ALLOWED_WHEN_HALTED,
  killSwitchState,
  setKillSwitch,
  tradingGate,
  type TradingAction,
} from "@/server/killSwitch";
import { tradingModeGate } from "@/server/tradingMode";
import { testDb } from "../helpers/pglite";

const SECRET = "v".repeat(48);
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const ORIGIN = "https://desk.example.com";
let db: Db;
let clock: ManualClock;
let deps: AuthDeps;
let owner: OwnerSecrets;
let cookie: string;

beforeEach(async () => {
  db = await testDb();
  clock = new ManualClock(Date.parse("2026-11-23T10:00:05Z"));
  deps = { db, clock, sessionSecret: SECRET, passwordParams: FAST };
  owner = await createOwner(db, {
    password: "a very good password",
    sessionSecret: SECRET,
    passwordParams: FAST,
  });
  const s1 = await passwordStep(deps, { password: "a very good password", ip: "1.2.3.4" });
  if (!s1.ok) throw new Error();
  const s2 = await secondFactorStep(deps, {
    pendingToken: s1.pendingToken,
    code: totpAt(owner.totpSecret, clock.now()),
    ip: "1.2.3.4",
  });
  if (!s2.ok) throw new Error();
  cookie = `${SESSION_COOKIE}=${s2.sessionToken}`;
});
afterEach(async () => {
  await db.close();
});

const req = (method: string, headers: Record<string, string> = {}, body?: unknown, url = `${ORIGIN}/api/x`) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("origin check (CSRF, second line after SameSite=Strict)", () => {
  it.each<[string, string, Record<string, string>, string | undefined, boolean]>([
    ["GET is always fine", "GET", {}, ORIGIN, true],
    ["POST with the app origin", "POST", { origin: ORIGIN }, ORIGIN, true],
    ["POST with another origin", "POST", { origin: "https://evil.example" }, ORIGIN, false],
    ["POST with no Origin header", "POST", {}, ORIGIN, false],
    [
      "POST marked cross-site by the browser",
      "POST",
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
      ORIGIN,
      false,
    ],
    [
      "mock without APP_ORIGIN: a non-loopback host is refused even from itself (DNS rebinding)",
      "POST",
      { origin: ORIGIN },
      undefined,
      false,
    ],
    [
      "mock without APP_ORIGIN: still rejects others",
      "POST",
      { origin: "http://localhost:9999" },
      undefined,
      false,
    ],
  ])("%s", (_n, method, headers, appOrigin, expected) => {
    expect(originAllowed(req(method, headers), appOrigin)).toBe(expected);
  });

  it.each([
    ["http://localhost:3000", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:3000", true],
    ["http://192.168.1.20:3000", false],
    ["http://attacker.example:3000", false],
  ])("mock without APP_ORIGIN, same-origin POST on %s → %s", (origin, expected) => {
    expect(originAllowed(req("POST", { origin }, undefined, `${origin}/api/x`), undefined)).toBe(expected);
  });
});

describe("route guard", () => {
  const errors: unknown[] = [];
  const guard = () =>
    makeGuard(
      () => Promise.resolve(deps),
      () => ({ appOrigin: ORIGIN }),
      () => ({ error: (o: unknown) => errors.push(o) }) as never,
    );

  it("no session → 401; valid session → the handler runs with it", async () => {
    const h = guard().authed({}, ({ session }) => Promise.resolve(ok({ user: session.userId })));
    expect((await h(req("POST", { origin: ORIGIN }))).status).toBe(401);
    const r = await h(req("POST", { origin: ORIGIN, cookie }));
    expect(await r.json()).toEqual({ user: owner.userId });
  });

  it("bad origin is refused before the session is even looked at", async () => {
    const h = guard().authed({}, () => Promise.resolve(ok({})));
    expect((await h(req("POST", { origin: "https://evil.example", cookie }))).status).toBe(403);
    const o = guard().open(() => Promise.resolve(ok({})));
    expect((await o(req("POST", {}))).status).toBe(403);
  });

  it("reauth: fresh right after login, stale 5 min later → 403 REAUTH_REQUIRED", async () => {
    const h = guard().authed({ reauth: true }, () => Promise.resolve(ok({ done: true })));
    expect((await h(req("POST", { origin: ORIGIN, cookie }))).status).toBe(200);
    clock.advance(LIMITS.reauthWindowMs + 1);
    const r = await h(req("POST", { origin: ORIGIN, cookie }));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: "REAUTH_REQUIRED" } });
  });

  it("a crashing handler → generic 500, details only in the log", async () => {
    const h = guard().authed({}, () => Promise.reject(new Error("db password is hunter2")));
    const r = await h(req("POST", { origin: ORIGIN, cookie }));
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toContain("hunter2");
    expect(text).toContain("INTERNAL");
    expect(errors).toHaveLength(1);
  });

  it("works without a logger too", async () => {
    const g = makeGuard(
      () => Promise.resolve(deps),
      () => ({ appOrigin: ORIGIN }),
    );
    expect((await g.open(() => Promise.reject(new Error("x")))(req("GET"))).status).toBe(500);
  });
});

describe("kill switch matrix (docs/05 Phase 05 required test)", () => {
  const ALL: TradingAction[] = [
    "levels",
    "closeAt",
    "breakeven",
    "lock",
    "market",
    "ladder",
    "cancel",
    "close",
  ];

  it.each(ALL)("%s: allowed when not halted", (action) => {
    expect(tradingGate(action, { halted: false, byEnv: false, byDb: false })).toEqual({ ok: true });
  });

  it.each(ALL)("%s when halted: only close-now gets through", (action) => {
    const gate = tradingGate(action, { halted: true, byEnv: false, byDb: true });
    expect(gate.ok).toBe(ALLOWED_WHEN_HALTED.has(action));
    expect(action === "close" ? gate.ok : !gate.ok).toBe(true);
  });

  it("says who halted it", () => {
    const msg = (byEnv: boolean, byDb: boolean) => {
      const g = tradingGate("levels", { halted: true, byEnv, byDb });
      return g.ok ? "" : g.message;
    };
    expect(msg(true, false)).toMatch(/server config \(TRADING_HALTED\)/);
    expect(msg(false, true)).toMatch(/by the app/);
    expect(msg(true, true)).toMatch(/server config and the app/);
  });

  it("state: env OR db; db flag persists and is audited", async () => {
    expect(await killSwitchState(db, false)).toEqual({ halted: false, byEnv: false, byDb: false });
    expect(await killSwitchState(db, true)).toEqual({ halted: true, byEnv: true, byDb: false });
    await setKillSwitch(deps, true, { userId: owner.userId });
    expect(await killSwitchState(db, false)).toEqual({ halted: true, byEnv: false, byDb: true });
    await setKillSwitch(deps, false, { userId: owner.userId });
    expect((await killSwitchState(db, false)).halted).toBe(false);
    const actions = (await db.query<{ action: string }>("select action from audit_log order by id")).map(
      (r) => r.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["kill_switch.on", "kill_switch.off"]));
  });
});

describe("admin routes", () => {
  const admin = () =>
    makeAdminRoutes(
      makeGuard(
        () => Promise.resolve(deps),
        () => ({ appOrigin: ORIGIN }),
      ),
      () => false,
    );
  const post = (body: unknown) => req("POST", { origin: ORIGIN, cookie }, body);

  it("kill switch ON never needs re-auth; OFF does", async () => {
    clock.advance(LIMITS.reauthWindowMs + 1);
    expect((await admin().killSwitchSet(post({ halted: true }))).status).toBe(200);
    const off = await admin().killSwitchSet(post({ halted: false }));
    expect(off.status).toBe(403);
    expect((await killSwitchState(db, false)).halted).toBe(true);
    const state = await admin().killSwitchGet(req("GET", { cookie }));
    expect(await state.json()).toEqual({ halted: true, byEnv: false, byDb: true });
  });

  it("OFF with a fresh re-auth works", async () => {
    await setKillSwitch(deps, true, { userId: owner.userId });
    expect(await (await admin().killSwitchSet(post({ halted: false }))).json()).toMatchObject({
      halted: false,
    });
  });

  it("validation and auth come first", async () => {
    expect((await admin().killSwitchSet(post({ halted: "no" }))).status).toBe(400);
    expect((await admin().killSwitchSet(req("POST", { origin: ORIGIN }, { halted: true }))).status).toBe(401);
  });

  it("live: enabling needs re-auth, disabling doesn't, unknown account is 404", async () => {
    const [acct] = await db.query<{ id: string }>(
      "insert into accounts (metaapi_account_id) values ('m1') returning id",
    );
    const id = acct!.id;
    expect(await (await admin().liveEnabled(post({ accountId: id, enabled: true }))).json()).toEqual({
      accountId: id,
      liveEnabled: true,
    });
    clock.advance(LIMITS.reauthWindowMs + 1);
    expect((await admin().liveEnabled(post({ accountId: id, enabled: false }))).status).toBe(200);
    expect((await admin().liveEnabled(post({ accountId: id, enabled: true }))).status).toBe(403);
    expect(
      (await admin().liveEnabled(post({ accountId: "00000000-0000-4000-8000-000000000000", enabled: false })))
        .status,
    ).toBe(404);
    expect((await admin().liveEnabled(post({ accountId: "nope", enabled: false }))).status).toBe(400);
    const actions = (await db.query<{ action: string }>("select action from audit_log order by id")).map(
      (r) => r.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["live.enabled", "live.disabled"]));
  });
});

describe("trading-mode gate (06-TESTING #12; a mislabelled account fails closed)", () => {
  it.each([
    ["mock", false, null, true],
    ["mock", false, "DEMO", false],
    ["demo", false, "DEMO", true],
    ["demo", false, "CONTEST", true],
    ["demo", true, "REAL", false],
    ["demo", false, null, false],
    ["live", false, "REAL", false],
    ["live", true, "DEMO", false],
    ["live", true, null, false],
    ["live", true, "REAL", true],
  ] as const)("mode=%s live_enabled=%s broker=%s → ok=%s", (mode, liveEnabled, brokerTradeMode, allowed) => {
    expect(tradingModeGate({ mode, liveEnabled, brokerTradeMode }).ok).toBe(allowed);
  });

  it("live without the DB flag is LIVE_NOT_ENABLED; a real account in demo mode is a mismatch", () => {
    expect(tradingModeGate({ mode: "live", liveEnabled: false, brokerTradeMode: "REAL" })).toMatchObject({
      code: "LIVE_NOT_ENABLED",
    });
    expect(tradingModeGate({ mode: "demo", liveEnabled: false, brokerTradeMode: "REAL" })).toMatchObject({
      code: "ACCOUNT_MODE_MISMATCH",
      message: "The app is in DEMO mode but the broker account is REAL. Refusing to trade.",
    });
  });
});

describe("routes wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("the real route table is built from the process env", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "pglite://memory");
    vi.stubEnv("LOG_LEVEL", "silent");
    const { authRoutes, adminRoutes } = await import("@/server/http/routes");
    const r = await authRoutes.session(new Request("http://localhost/api/auth/session"));
    expect(await r.json()).toEqual({ authenticated: false });
    expect(
      (await authRoutes.login(new Request("http://localhost/api/auth/login", { method: "POST", body: "{}" })))
        .status,
    ).toBe(403);
    expect(
      (await adminRoutes.killSwitchGet(new Request("http://localhost/api/admin/kill-switch"))).status,
    ).toBe(401);
    for (const name of ["totp", "logout", "reauth"] as const) {
      expect((await authRoutes[name](new Request("http://localhost/x", { method: "POST" }))).status).toBe(
        403,
      );
    }
    const { getDb } = await import("@/server/context");
    await (await getDb()).close();
  });
});
