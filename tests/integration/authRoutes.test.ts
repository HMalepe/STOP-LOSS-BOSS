import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "@/domain/clock";
import { clearCookie, PENDING_COOKIE, SESSION_COOKIE, setCookie } from "@/server/auth/cookies";
import type { AuthDeps } from "@/server/auth/login";
import { createOwner, type OwnerSecrets } from "@/server/auth/owner";
import { totpAt } from "@/server/auth/totp";
import type { Db } from "@/server/db/sql";
import { makeAuthRoutes } from "@/server/http/authRoutes";
import { fail, ok, statusOf } from "@/server/http/respond";
import { clientIp, MAX_BODY_BYTES, parseJson, readCookie } from "@/server/http/request";
import { z } from "zod";
import { testDb } from "../helpers/pglite";

const SECRET = "w".repeat(48);
const PASSWORD = "a very good password";
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
let db: Db;
let clock: ManualClock;
let deps: AuthDeps;
let owner: OwnerSecrets;
let routes: ReturnType<typeof makeAuthRoutes>;

beforeEach(async () => {
  db = await testDb();
  clock = new ManualClock(Date.parse("2026-11-23T10:00:05Z"));
  deps = {
    db,
    clock,
    sessionSecret: SECRET,
    passwordParams: FAST,
  };
  owner = await createOwner(db, {
    password: PASSWORD,
    sessionSecret: SECRET,
    passwordParams: FAST,
  });
  routes = makeAuthRoutes(() => Promise.resolve(deps));
});
afterEach(async () => {
  await db.close();
});

function post(path: string, body: unknown, cookie?: string, ip = "203.0.113.9"): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `1.1.1.1, ${ip}`,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const cookieValue = (res: Response, name: string) => {
  const all = res.headers.getSetCookie();
  const c = all.find((h) => h.startsWith(`${name}=`));
  return c === undefined ? undefined : decodeURIComponent(c.slice(name.length + 1).split(";")[0] ?? "");
};

describe("cookies are locked down (docs/05)", () => {
  it("__Host- prefix, HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age", () => {
    expect(setCookie(SESSION_COOKIE, "abc", 60.9)).toBe(
      "__Host-od_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=60",
    );
    expect(clearCookie(PENDING_COOKIE)).toBe(
      "__Host-od_pending=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    );
    expect(setCookie("x", "v", -5)).toMatch(/Max-Age=0$/);
  });
});

describe("POST /api/auth/login → /api/auth/totp → session", () => {
  it("the whole flow sets the right cookies and the session works", async () => {
    const r1 = await routes.login(post("/api/auth/login", { password: PASSWORD }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ needsTotp: true });
    const pending = cookieValue(r1, PENDING_COOKIE);
    expect(pending).toBeDefined();
    expect(r1.headers.get("cache-control")).toBe("no-store");

    const r2 = await routes.totp(
      post(
        "/api/auth/totp",
        { code: totpAt(owner.totpSecret, clock.now()) },
        `${PENDING_COOKIE}=${pending ?? ""}`,
      ),
    );
    expect(r2.status).toBe(200);
    const session = cookieValue(r2, SESSION_COOKIE);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r2.headers.getSetCookie().find((h) => h.startsWith(SESSION_COOKIE))).toMatch(/Max-Age=604800/);
    expect(cookieValue(r2, PENDING_COOKIE)).toBe("");

    const me = await routes.session(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: `${SESSION_COOKIE}=${session ?? ""}` },
      }),
    );
    expect(await me.json()).toMatchObject({ authenticated: true, reauthFresh: true });

    const out = await routes.logout(post("/api/auth/logout", {}, `${SESSION_COOKIE}=${session ?? ""}`));
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const after = await routes.session(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: `${SESSION_COOKIE}=${session ?? ""}` },
      }),
    );
    expect(await after.json()).toEqual({ authenticated: false });
  });

  it("wrong password → 401 in the error shape, no cookie", async () => {
    const r = await routes.login(post("/api/auth/login", { password: "nope nope nope" }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Wrong password or code." },
    });
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("TOTP without the pending cookie → 401", async () => {
    const r = await routes.totp(post("/api/auth/totp", { code: "123456" }));
    expect(r.status).toBe(401);
  });

  it("bad bodies → 400 VALIDATION", async () => {
    expect((await routes.login(post("/api/auth/login", "not json"))).status).toBe(400);
    expect((await routes.login(post("/api/auth/login", { password: "" }))).status).toBe(400);
    expect((await routes.totp(post("/api/auth/totp", { code: 5 }))).status).toBe(400);
    expect((await routes.reauth(post("/api/auth/reauth", {}))).status).toBe(400);
  });

  it("rate limited → 429 with Retry-After in seconds", async () => {
    for (let i = 0; i < 5; i++) await routes.login(post("/api/auth/login", { password: "wrong wrong" }));
    const r = await routes.login(post("/api/auth/login", { password: PASSWORD }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
  });

  it("re-auth needs a session, and a valid fresh code", async () => {
    expect((await routes.reauth(post("/api/auth/reauth", { code: "123456" }))).status).toBe(401);
    const r1 = await routes.login(post("/api/auth/login", { password: PASSWORD }));
    const r2 = await routes.totp(
      post(
        "/api/auth/totp",
        { code: totpAt(owner.totpSecret, clock.now()) },
        `${PENDING_COOKIE}=${cookieValue(r1, PENDING_COOKIE) ?? ""}`,
      ),
    );
    const cookie = `${SESSION_COOKIE}=${cookieValue(r2, SESSION_COOKIE) ?? ""}`;
    clock.advance(60_000);
    expect((await routes.reauth(post("/api/auth/reauth", { code: "000000" }, cookie))).status).toBe(401);
    expect(
      (await routes.reauth(post("/api/auth/reauth", { code: totpAt(owner.totpSecret, clock.now()) }, cookie)))
        .status,
    ).toBe(200);
  });

  it("logout without a cookie still clears and returns 204", async () => {
    expect((await routes.logout(post("/api/auth/logout", {}))).status).toBe(204);
  });
});

describe("request helpers", () => {
  it("client IP comes ONLY from the trusted header; X-Forwarded-For → its right-most entry", () => {
    const req = (h: Record<string, string>) => new Request("http://x", { headers: h });
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.5" }))).toBe("203.0.113.5");
    expect(clientIp(req({ "x-forwarded-for": " , " }))).toBe("unknown");
    expect(clientIp(req({}))).toBe("unknown");
    // Another header is the client's to forge: it is never consulted unless configured.
    expect(clientIp(req({ "x-real-ip": "198.51.100.2" }))).toBe("unknown");
    expect(clientIp(req({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "9.9.9.9" }), "x-real-ip")).toBe(
      "198.51.100.2",
    );
    expect(clientIp(req({ "cf-connecting-ip": " 2001:db8::1 " }), "cf-connecting-ip")).toBe("2001:db8::1");
    expect(clientIp(req({ "fly-client-ip": "x".repeat(500) }), "fly-client-ip")).toHaveLength(64);
  });

  it("cookies: finds by exact name, decodes, ignores junk", () => {
    const req = new Request("http://x", { headers: { cookie: "a=1; junk; __Host-od_session=x%2By; b=2" } });
    expect(readCookie(req, SESSION_COOKIE)).toBe("x+y");
    expect(readCookie(req, "od_session")).toBeUndefined();
    expect(readCookie(new Request("http://x"), "a")).toBeUndefined();
  });

  it("bodies: too large, empty, and schema errors with a path", async () => {
    const schema = z.object({ a: z.number() });
    const big = new Request("http://x", { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(await parseJson(big, schema)).toEqual({ ok: false, message: "Request body too large." });
    expect(await parseJson(new Request("http://x", { method: "POST", body: "" }), z.object({}))).toEqual({
      ok: true,
      value: {},
    });
    expect(
      await parseJson(new Request("http://x", { method: "POST", body: '{"a":"x"}' }), schema),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/^a:/) as unknown });
    expect(await parseJson(new Request("http://x", { method: "POST", body: "5" }), schema)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/^body:/) as unknown,
    });
  });

  it("responses: no-store, error shape and statuses", async () => {
    const r = fail("TRADING_HALTED", "Halted.", { details: { by: "env" } });
    expect(r.status).toBe(423);
    expect(await r.json()).toEqual({
      error: { code: "TRADING_HALTED", message: "Halted.", details: { by: "env" } },
    });
    expect(ok({ a: 1 }, 201).status).toBe(201);
    expect(statusOf("PLAN_ALREADY_EXECUTED")).toBe(409);
  });
});

describe("context wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__orderDeskDb;
  });

  it("pglite URLs map to a directory or memory", async () => {
    const { pgliteDir } = await import("@/server/context");
    expect(pgliteDir("pglite://memory")).toBeUndefined();
    expect(pgliteDir("pglite:")).toBeUndefined();
    expect(pgliteDir("pglite://.data/order-desk")).toBe(".data/order-desk");
  });

  it("getDb opens and migrates once; getAuthDeps carries the session secret", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "pglite://memory");
    const ctx = await import("@/server/context");
    const a = await ctx.getDb();
    expect(await ctx.getDb()).toBe(a);
    expect(await a.query("select count(*)::int as n from schema_migrations")).toEqual([{ n: 4 }]);
    const d = await ctx.getAuthDeps();
    expect(d.sessionSecret).toBe(SECRET);
    await a.close();
  });

  it("a failed open is forgotten so the next call retries", async () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "pglite://memory");
    const ctx = await import("@/server/context");
    const migrateMod = await import("@/server/db/migrate");
    const spy = vi.spyOn(migrateMod, "migrate").mockRejectedValueOnce(new Error("db down"));
    await expect(ctx.getDb()).rejects.toThrow("db down");
    spy.mockRestore();
    const db2 = await ctx.getDb();
    await db2.close();
  });
});
