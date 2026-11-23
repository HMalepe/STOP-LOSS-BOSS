/**
 * Regression tests for the Phase 05 security review (docs/05-SECURITY.md, "Review findings"). Each one reproduces the
 * attack the reviewer described and asserts it now fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "@/domain/clock";
import { auditKey, verifyChain } from "@/server/audit/audit";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { HashGate } from "@/server/auth/hashGate";
import {
  ipKey,
  LIMITS,
  lockoutRemaining,
  passwordStep,
  reauth,
  secondFactorStep,
  validateSession,
  type AuthDeps,
  type Session,
} from "@/server/auth/login";
import { createOwner, type OwnerSecrets } from "@/server/auth/owner";
import { totpAt } from "@/server/auth/totp";
import type { Db } from "@/server/db/sql";
import { makeAdminRoutes } from "@/server/http/adminRoutes";
import { makeGuard } from "@/server/http/guard";
import { setKillSwitch } from "@/server/killSwitch";
import { testDb } from "../helpers/pglite";

const SECRET = "s".repeat(48);
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const PASSWORD = "a very good password";
const ORIGIN = "https://desk.example.com";
const WRONG = "000000";

let db: Db;
let clock: ManualClock;
let deps: AuthDeps;
let owner: OwnerSecrets;

beforeEach(async () => {
  db = await testDb();
  clock = new ManualClock(Date.parse("2026-11-23T10:00:05Z"));
  deps = { db, clock, sessionSecret: SECRET, passwordParams: FAST, hashGate: new HashGate(50, 50) };
  owner = await createOwner(db, { password: PASSWORD, sessionSecret: SECRET, passwordParams: FAST });
});
afterEach(async () => {
  await db.close();
});

const code = () => totpAt(owner.totpSecret, clock.now());
async function pendingFrom(ip: string): Promise<string> {
  const r = await passwordStep(deps, { password: PASSWORD, ip });
  if (!r.ok) throw new Error(`setup: ${r.message}`);
  return r.pendingToken;
}
async function sessionFrom(ip: string): Promise<{ token: string; session: Session }> {
  const r = await secondFactorStep(deps, { pendingToken: await pendingFrom(ip), code: code(), ip });
  if (!r.ok) throw new Error(`setup: ${r.message}`);
  const session = await validateSession(deps, r.sessionToken);
  if (session === null) throw new Error("setup: no session");
  return { token: r.sessionToken, session };
}
const count = (rs: readonly { ok: boolean; code?: string }[], c: string) =>
  rs.filter((r) => !r.ok && r.code === c).length;
const audited = async (action: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from audit_log where action = $1", [action]))[0]
    ?.n ?? 0;

describe("HIGH 1: parallel guesses can't outrun the rate limit (reserve-then-verify)", () => {
  it("50 parallel second-factor guesses from one IP: at most 5 are ever checked", async () => {
    // Ten pending logins (the attacker has the password), so the per-pending cap of 5 isn't what stops them.
    const tokens = await Promise.all(
      Array.from({ length: 10 }, (_, i) => pendingFrom(`198.51.100.${String(i)}`)),
    );
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        secondFactorStep(deps, { pendingToken: tokens[i % 10] ?? "", code: WRONG, ip: "203.0.113.50" }),
      ),
    );
    expect(count(results, "UNAUTHENTICATED")).toBeLessThanOrEqual(LIMITS.failuresPerMinute);
    expect(count(results, "RATE_LIMITED")).toBeGreaterThanOrEqual(45);
    expect(await audited("login.second_factor_failed")).toBeLessThanOrEqual(LIMITS.failuresPerMinute);
  });

  it("50 parallel guesses on ONE pending login: the pending cap holds too (each attempt is spent atomically)", async () => {
    const token = await pendingFrom("198.51.100.1");
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        secondFactorStep(deps, { pendingToken: token, code: WRONG, ip: `192.0.2.${String(i)}` }),
      ),
    );
    expect(await audited("login.second_factor_failed")).toBe(LIMITS.pendingMaxAttempts);
    expect(results.filter((r) => !r.ok && r.message === "Login expired. Start again.")).toHaveLength(45);
  });

  it("50 parallel re-auth guesses with a stolen cookie: at most 5 checked, and the session is revoked", async () => {
    const { token, session } = await sessionFrom("198.51.100.7");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reauth(deps, session, WRONG, "203.0.113.66")),
    );
    expect(count(results, "UNAUTHENTICATED")).toBeLessThanOrEqual(LIMITS.failuresPerMinute);
    expect(await validateSession(deps, token)).toBeNull();
    expect(await audited("session.revoked_reauth_failures")).toBeGreaterThanOrEqual(1);
  });

  it("50 parallel wrong passwords: at most 5 hashed, the rest refused before argon2 runs", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        passwordStep(deps, { password: "wrong wrong wrong", ip: "203.0.113.9" }),
      ),
    );
    expect(count(results, "UNAUTHENTICATED")).toBe(LIMITS.failuresPerMinute);
    expect(count(results, "RATE_LIMITED")).toBe(45);
  });
});

describe("HIGH 1b: re-auth failures revoke the session", () => {
  it("3 wrong codes in a row → revoked; a success in between resets the count", async () => {
    const { token, session } = await sessionFrom("198.51.100.8");
    expect(await reauth(deps, session, WRONG, "198.51.100.8")).toMatchObject({ message: "Wrong code." });
    expect(await reauth(deps, session, WRONG, "198.51.100.8")).toMatchObject({ message: "Wrong code." });
    clock.advance(30_000);
    expect(await reauth(deps, session, code(), "198.51.100.8")).toEqual({ ok: true });
    expect(await reauth(deps, session, WRONG, "198.51.100.8")).toMatchObject({ message: "Wrong code." });
    expect(await reauth(deps, session, WRONG, "198.51.100.8")).toMatchObject({ message: "Wrong code." });
    expect(await validateSession(deps, token)).not.toBeNull();
    expect(await reauth(deps, session, WRONG, "198.51.100.8")).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Too many wrong codes. Sign in again.",
    });
    expect(await validateSession(deps, token)).toBeNull();
  });
});

describe("HIGH 2: the second factor has a per-account budget, whatever the IP", () => {
  it("40 IPs × 5 wrong codes: the 11th failure is refused, the owner's real code too, for an hour", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 40 && outcomes.length < 30; i++) {
      const ip = `100.64.${String(i)}.1`;
      const token = await pendingFrom(ip);
      for (let j = 0; j < 5; j++) {
        const r = await secondFactorStep(deps, { pendingToken: token, code: WRONG, ip });
        outcomes.push(r.ok ? "ok" : r.code);
      }
    }
    expect(outcomes.slice(0, LIMITS.userSecondFactorFailures)).toEqual(
      Array<string>(LIMITS.userSecondFactorFailures).fill("UNAUTHENTICATED"),
    );
    expect(outcomes[LIMITS.userSecondFactorFailures]).toBe("RATE_LIMITED");
    expect(new Set(outcomes.slice(LIMITS.userSecondFactorFailures))).toEqual(new Set(["RATE_LIMITED"]));

    const blocked = await secondFactorStep(deps, {
      pendingToken: await pendingFrom("198.51.100.200"),
      code: code(),
      ip: "198.51.100.200",
    });
    expect(blocked).toMatchObject({ code: "RATE_LIMITED" });
    if (!blocked.ok && blocked.code === "RATE_LIMITED") {
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(LIMITS.userWindowMs);
    }

    clock.advance(LIMITS.userWindowMs + 1);
    const later = await secondFactorStep(deps, {
      pendingToken: await pendingFrom("198.51.100.201"),
      code: code(),
      ip: "198.51.100.201",
    });
    expect(later.ok).toBe(true);
  });

  it("a successful sign-in clears the account budget (the owner's typos don't accumulate)", async () => {
    for (let i = 0; i < 9; i++) {
      const ip = `100.65.${String(i)}.1`;
      await secondFactorStep(deps, { pendingToken: await pendingFrom(ip), code: WRONG, ip });
    }
    await sessionFrom("198.51.100.9");
    clock.advance(30_000);
    for (let i = 0; i < 9; i++) {
      const ip = `100.66.${String(i)}.1`;
      expect(
        await secondFactorStep(deps, { pendingToken: await pendingFrom(ip), code: WRONG, ip }),
      ).toMatchObject({
        code: "UNAUTHENTICATED",
      });
    }
  });

  it("the password step is NOT account-wide (nobody can lock the owner out with wrong passwords)", async () => {
    for (let i = 0; i < 30; i++) {
      await passwordStep(deps, { password: "wrong wrong wrong", ip: `100.70.${String(i)}.1` });
    }
    expect((await passwordStep(deps, { password: PASSWORD, ip: "198.51.100.10" })).ok).toBe(true);
  });

  it("IPv6: one /64 is one throttle bucket (a subscriber can't rotate through their 2^64 addresses)", async () => {
    for (let i = 1; i <= 5; i++) {
      await passwordStep(deps, { password: "wrong wrong wrong", ip: `2001:db8:abcd:12::${i.toString(16)}` });
    }
    expect(await passwordStep(deps, { password: PASSWORD, ip: "2001:db8:abcd:12:ffff:1:2:3" })).toMatchObject(
      {
        code: "RATE_LIMITED",
      },
    );
    expect(await lockoutRemaining(deps, "2001:0db8:abcd:0012::beef")).toBe(60_000);
    // The neighbouring /64 is someone else.
    expect((await passwordStep(deps, { password: PASSWORD, ip: "2001:db8:abcd:13::1" })).ok).toBe(true);
  });
});

describe("ipKey", () => {
  it.each([
    ["203.0.113.5", "203.0.113.5"],
    [" 203.0.113.5 ", "203.0.113.5"],
    ["::ffff:203.0.113.5", "203.0.113.5"],
    ["::FFFF:203.0.113.5", "203.0.113.5"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd:12::/64"],
    ["2001:0DB8:ABCD:0012:0000:0000:0000:0001", "2001:db8:abcd:12::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["unknown", "unknown"],
    ["not-an-ip", "not-an-ip"],
    ["x".repeat(100), "x".repeat(64)],
  ])("%s → %s", (raw, key) => {
    expect(ipKey(raw)).toBe(key);
  });
});

describe("MEDIUM: password hashing is bounded (memory-exhaustion flood)", () => {
  it("HashGate: max in flight, a bounded queue, then null; each slot released once and handed over", async () => {
    const gate = new HashGate(2, 1);
    const a = await gate.enter();
    const b = await gate.enter();
    const queued = gate.enter();
    expect(gate.enter()).toBeNull();
    expect([gate.inFlight, gate.queued]).toEqual([2, 1]);
    a?.();
    a?.(); // double release is harmless
    const c = await queued;
    expect([gate.inFlight, gate.queued]).toEqual([2, 0]);
    b?.();
    c?.();
    expect(gate.inFlight).toBe(0);
  });

  it("a full gate answers 429 Busy, without recording an attempt", async () => {
    const gate = new HashGate(1, 0);
    const hold = await gate.enter();
    const r = await passwordStep({ ...deps, hashGate: gate }, { password: PASSWORD, ip: "203.0.113.1" });
    expect(r).toEqual({
      ok: false,
      code: "RATE_LIMITED",
      message: "Busy. Try again in a moment.",
      retryAfterMs: LIMITS.busyRetryMs,
    });
    expect(await db.query("select * from login_attempts")).toEqual([]);
    hold?.();
    expect(
      (await passwordStep({ ...deps, hashGate: gate }, { password: PASSWORD, ip: "203.0.113.1" })).ok,
    ).toBe(true);
    expect(gate.inFlight).toBe(0);
  });
});

describe("HIGH 3: incident response works", () => {
  const admin = () =>
    makeAdminRoutes(
      makeGuard(
        () => Promise.resolve(deps),
        () => ({ appOrigin: ORIGIN, ipHeader: "cf-connecting-ip" }),
      ),
      () => false,
    );
  const post = (cookie: string) =>
    new Request(`${ORIGIN}/api/auth/sessions/revoke-all`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${cookie}`, "cf-connecting-ip": "198.51.100.77" },
    });

  it("rotating the owner after the kill switch was used (config references the owner) revokes every old session", async () => {
    const { token, session } = await sessionFrom("198.51.100.11");
    await setKillSwitch(deps, true, session);
    await setKillSwitch(deps, false, session);
    await createOwner(db, {
      password: "a brand new password",
      sessionSecret: SECRET,
      replace: true,
      passwordParams: FAST,
    });
    expect(await validateSession(deps, token)).toBeNull();
    expect((await passwordStep(deps, { password: PASSWORD, ip: "198.51.100.12" })).ok).toBe(false);
    expect((await passwordStep(deps, { password: "a brand new password", ip: "198.51.100.12" })).ok).toBe(
      true,
    );
    expect(await verifyChain(db, auditKey(SECRET))).toMatchObject({ ok: true });
  });

  it("sign out everywhere: re-auth gated, revokes every device (this one too), clears the cookie, audited", async () => {
    const phone = await sessionFrom("198.51.100.13");
    clock.advance(30_000); // next TOTP step: the same code can't be used twice
    const laptop = await sessionFrom("198.51.100.14");

    clock.advance(LIMITS.reauthWindowMs + 1);
    const stale = await admin().revokeAllSessions(post(laptop.token));
    expect(stale.status).toBe(403);
    expect(await validateSession(deps, phone.token)).not.toBeNull();

    clock.advance(30_000);
    const fresh = await validateSession(deps, laptop.token);
    if (fresh === null) throw new Error("setup");
    expect(await reauth(deps, fresh, code(), "198.51.100.14")).toEqual({ ok: true });
    const res = await admin().revokeAllSessions(post(laptop.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 2 });
    expect(res.headers.get("set-cookie")).toMatch(/^__Host-od_session=; .*Max-Age=0$/);
    expect(await validateSession(deps, phone.token)).toBeNull();
    expect(await validateSession(deps, laptop.token)).toBeNull();
    const [row] = await db.query<{ details: unknown }>(
      "select details from audit_log where action = 'sessions.revoked_all'",
    );
    // The IP came from the configured trusted header.
    expect(row?.details).toEqual({ ip: "198.51.100.77", count: 2 });
  });

  it("without a session it is just 401", async () => {
    expect((await admin().revokeAllSessions(post("nope"))).status).toBe(401);
  });
});

describe("MEDIUM: a change and its audit row are atomic", () => {
  it("if the audit write fails, the kill switch does not change", async () => {
    const { session } = await sessionFrom("198.51.100.15");
    // A transaction whose audit insert fails (disk full, constraint, anything).
    const breakAudit = (t: Db): Db => {
      const wrapped: Db = {
        query: (text, params) =>
          text.startsWith("insert into audit_log")
            ? Promise.reject(new Error("disk full"))
            : t.query(text, params),
        tx: (fn) => fn(wrapped),
        close: () => t.close(),
      };
      return wrapped;
    };
    const failing: Db = { ...db, tx: (fn) => db.tx((t) => fn(breakAudit(t))) };
    await expect(setKillSwitch({ ...deps, db: failing }, true, session)).rejects.toThrow("disk full");
    expect(await db.query("select * from config where key = 'kill_switch'")).toEqual([]);
  });
});
