import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyChain } from "@/server/audit/audit";
import { createOwner, type OwnerSecrets } from "@/server/auth/owner";
import {
  hasFreshReauth,
  LIMITS,
  lockoutRemaining,
  logout,
  passwordStep,
  reauth,
  secondFactorStep,
  validateSession,
  type AuthDeps,
} from "@/server/auth/login";
import { totpAt } from "@/server/auth/totp";
import { ManualClock } from "@/domain/clock";
import type { Db } from "@/server/db/sql";
import { testDb } from "../helpers/pglite";

const SECRET = "y".repeat(48);
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const PASSWORD = "a very good password";
const IP = "203.0.113.7";

let db: Db;
let clock: ManualClock;
let deps: AuthDeps;
let owner: OwnerSecrets;

beforeEach(async () => {
  db = await testDb();
  clock = new ManualClock(Date.parse("2026-11-23T10:00:00Z"));
  deps = { db, clock, sessionSecret: SECRET, passwordParams: FAST };
  owner = await createOwner(db, { password: PASSWORD, sessionSecret: SECRET, passwordParams: FAST });
});
afterEach(async () => {
  await db.close();
});

const code = () => totpAt(owner.totpSecret, clock.now());
async function login(ip = IP): Promise<string> {
  const step1 = await passwordStep(deps, { password: PASSWORD, ip });
  if (!step1.ok) throw new Error(step1.message);
  const step2 = await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: code(), ip });
  if (!step2.ok) throw new Error(step2.message);
  return step2.sessionToken;
}
const actions = async () =>
  (await db.query<{ action: string }>("select action from audit_log order by id")).map((r) => r.action);

describe("login: password then TOTP", () => {
  it("happy path: pending token → session that validates; audited; chain intact", async () => {
    const token = await login();
    const session = await validateSession(deps, token);
    expect(session?.userId).toBe(owner.userId);
    expect(session?.absoluteExpiresAt).toBe(clock.now() + LIMITS.absoluteMs);
    expect(await actions()).toEqual(["owner.created", "login.ok"]);
    expect((await verifyChain(db)).ok).toBe(true);
  });

  it("nothing secret is stored in the clear: session and pending ids are hashes", async () => {
    const token = await login();
    const rows = await db.query<{ id_hash: string }>("select id_hash from sessions");
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.id_hash).not.toContain(token);
  });

  it("wrong password → generic error, audited", async () => {
    expect(await passwordStep(deps, { password: "nope nope nope", ip: IP })).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
      message: "Wrong password or code.",
    });
    expect(await actions()).toContain("login.password_failed");
  });

  it("no owner yet → same generic error (no account enumeration)", async () => {
    await db.query("delete from users");
    expect((await passwordStep(deps, { password: PASSWORD, ip: IP })).ok).toBe(false);
  });

  it("wrong code fails; a pending login dies after 5 wrong codes", async () => {
    const step1 = await passwordStep(deps, { password: PASSWORD, ip: "198.51.100.1" });
    if (!step1.ok) throw new Error();
    for (let i = 0; i < LIMITS.pendingMaxAttempts; i++) {
      expect(
        (
          await secondFactorStep(deps, {
            pendingToken: step1.pendingToken,
            code: "000000",
            ip: `198.51.100.${String(10 + i)}`,
          })
        ).ok,
      ).toBe(false);
    }
    expect(
      await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: code(), ip: "198.51.100.99" }),
    ).toMatchObject({ ok: false, message: "Login expired. Start again." });
  });

  it("the pending token expires after 5 minutes", async () => {
    const step1 = await passwordStep(deps, { password: PASSWORD, ip: IP });
    if (!step1.ok) throw new Error();
    clock.advance(LIMITS.pendingTtlMs);
    expect(
      await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: code(), ip: IP }),
    ).toMatchObject({ ok: false, message: "Login expired. Start again." });
  });

  it("the pending token is single use", async () => {
    const step1 = await passwordStep(deps, { password: PASSWORD, ip: IP });
    if (!step1.ok) throw new Error();
    expect(
      (await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: code(), ip: IP })).ok,
    ).toBe(true);
    clock.advance(30_000);
    expect(
      (await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: code(), ip: IP })).ok,
    ).toBe(false);
  });

  it("a TOTP code can't be replayed, even in a second login", async () => {
    const used = code();
    await login();
    const step1 = await passwordStep(deps, { password: PASSWORD, ip: IP });
    if (!step1.ok) throw new Error();
    expect((await secondFactorStep(deps, { pendingToken: step1.pendingToken, code: used, ip: IP })).ok).toBe(
      false,
    );
  });
});

describe("recovery codes", () => {
  it("each works once, the audit says how many are left", async () => {
    const recovery = owner.recoveryCodes[0]!;
    const step1 = await passwordStep(deps, { password: PASSWORD, ip: IP });
    if (!step1.ok) throw new Error();
    expect(
      (
        await secondFactorStep(deps, {
          pendingToken: step1.pendingToken,
          code: recovery.toLowerCase(),
          ip: IP,
        })
      ).ok,
    ).toBe(true);
    const details = await db.query<{ details: { recoveryCodesLeft?: number } }>(
      "select details from audit_log where action = 'login.ok_recovery_code'",
    );
    expect(details[0]?.details.recoveryCodesLeft).toBe(9);

    const again = await passwordStep(deps, { password: PASSWORD, ip: IP });
    if (!again.ok) throw new Error();
    expect(
      (await secondFactorStep(deps, { pendingToken: again.pendingToken, code: recovery, ip: IP })).ok,
    ).toBe(false);
  });
});

describe("rate limit and lockout (per IP, never a global lockout)", () => {
  it("5 failures → locked for 1 min, then doubling", async () => {
    for (let i = 0; i < 5; i++) await passwordStep(deps, { password: "wrong wrong wrong", ip: IP });
    const locked = await passwordStep(deps, { password: PASSWORD, ip: IP });
    expect(locked).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(await lockoutRemaining(deps, IP)).toBe(60_000);
    clock.advance(60_001);
    await passwordStep(deps, { password: "wrong wrong wrong", ip: IP });
    expect(await lockoutRemaining(deps, IP)).toBe(120_000);
  });

  it("lockout is capped at 24 h", async () => {
    for (let i = 0; i < 40; i++) {
      await db.query("insert into login_attempts (ip, stage, ok, at) values ($1, 'password', false, $2)", [
        IP,
        new Date(clock.now() - i * 1_000).toISOString(),
      ]);
    }
    expect(await lockoutRemaining(deps, IP)).toBe(LIMITS.lockoutMaxMs);
  });

  it("an attacker's IP being locked never locks the owner on another IP", async () => {
    for (let i = 0; i < 10; i++) await passwordStep(deps, { password: "attack attack", ip: "192.0.2.66" });
    expect((await passwordStep(deps, { password: PASSWORD, ip: IP })).ok).toBe(true);
  });

  it("a successful login resets the count for that IP", async () => {
    for (let i = 0; i < 4; i++) await passwordStep(deps, { password: "typo typo typo", ip: IP });
    await login();
    clock.advance(60_000);
    for (let i = 0; i < 4; i++) await passwordStep(deps, { password: "typo typo typo", ip: IP });
    expect(await lockoutRemaining(deps, IP)).toBe(0);
  });

  it("the TOTP step is rate limited too", async () => {
    for (let i = 0; i < 5; i++) {
      await db.query("insert into login_attempts (ip, stage, ok, at) values ($1, 'totp', false, $2)", [
        IP,
        new Date(clock.now()).toISOString(),
      ]);
    }
    expect(await secondFactorStep(deps, { pendingToken: "x", code: "123456", ip: IP })).toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});

describe("sessions", () => {
  it("idle timeout 12 h (slides with use), absolute 7 d", async () => {
    const token = await login();
    clock.advance(LIMITS.idleMs - 1_000);
    expect(await validateSession(deps, token)).not.toBeNull(); // touches last_seen
    clock.advance(LIMITS.idleMs - 1_000);
    expect(await validateSession(deps, token)).not.toBeNull();
    clock.advance(LIMITS.idleMs + 1);
    expect(await validateSession(deps, token)).toBeNull();
  });

  it("absolute expiry wins over activity", async () => {
    const token = await login();
    for (let t = 0; t < 15; t++) {
      clock.advance(LIMITS.idleMs - 60_000);
      await validateSession(deps, token);
    }
    expect(await validateSession(deps, token)).toBeNull();
  });

  it("logout revokes; unknown/empty tokens are just null", async () => {
    const token = await login();
    await logout(deps, token);
    expect(await validateSession(deps, token)).toBeNull();
    expect(await validateSession(deps, "nope")).toBeNull();
    expect(await validateSession(deps, undefined)).toBeNull();
    await logout(deps, undefined);
    await logout(deps, "nope");
    expect(await actions()).toContain("logout");
  });

  it("re-auth: fresh at login, stale after 5 min, renewed by a new TOTP", async () => {
    const token = await login();
    let s = await validateSession(deps, token);
    expect(hasFreshReauth(s!, clock.now())).toBe(true);
    clock.advance(LIMITS.reauthWindowMs + 1);
    s = await validateSession(deps, token);
    expect(hasFreshReauth(s!, clock.now())).toBe(false);
    expect((await reauth(deps, s!, "000000", IP)).ok).toBe(false);
    expect((await reauth(deps, s!, code(), IP)).ok).toBe(true);
    s = await validateSession(deps, token);
    expect(hasFreshReauth(s!, clock.now())).toBe(true);
    expect(await actions()).toEqual(expect.arrayContaining(["reauth.failed", "reauth.ok"]));
  });

  it("re-auth is rate limited and refuses a replayed code", async () => {
    const token = await login();
    clock.advance(1_000); // same 30 s TOTP step, a moment later
    const s = await validateSession(deps, token);
    expect((await reauth(deps, s!, code(), IP)).ok).toBe(false); // same step as the login code
    for (let i = 0; i < 6; i++) await reauth(deps, s!, "000000", IP);
    expect(await reauth(deps, s!, "000000", IP)).toMatchObject({ code: "RATE_LIMITED" });
  });
});
