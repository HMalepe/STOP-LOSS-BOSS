/**
 * Login (docs/05-SECURITY.md): password → TOTP (or a recovery code) → session.
 *
 * Throttling, all enforced BEFORE any secret is checked (reserve-then-verify):
 * - Every attempt first RESERVES a row in login_attempts (written as a failure) under one database lock, and only then
 *   verifies. So 50 parallel guesses can't all slip past a check that ran before any of them was recorded: at most the
 *   allowance gets verified, the rest are refused unseen. A success flips its row to ok.
 * - Per client network (an IPv4 address, or an IPv6 /64, which one subscriber owns): 5 failures/minute, then an
 *   exponential lockout (1 min, 2, 4… capped 24 h). Deliberately NOT a global lockout on the password step: with one
 *   owner, that would let anyone lock the owner out.
 * - Per account, on the second factor (TOTP, recovery code, re-auth): 10 failures an hour, whatever the IP. Only someone
 *   who already has the password (or a session) can spend this budget, so rotating IPs buys an attacker nothing.
 * - A session that fails re-auth 3 times in a row is revoked (a stolen cookie doesn't get to keep guessing).
 * - Password hashing is gated (HashGate): a flood of logins gets 429s instead of exhausting memory.
 *
 * Timing: a wrong password and a missing account take the same time (a dummy hash is always verified).
 * Step 1 hands out a short-lived single-use pending token; step 2 turns it into a session. Both stored hashed.
 * Sessions: 256-bit random id, 12 h idle, 7 d absolute; a fresh TOTP counts as re-auth for sensitive changes.
 * Every outcome is audited (never with secrets).
 */
import { isIPv4, isIPv6 } from "node:net";
import type { Clock } from "@/domain/clock";
import { audit, auditKey, type AuditEntry } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import { randomToken, sha256 } from "./crypto";
import { HashGate } from "./hashGate";
import { openTotpSecret } from "./owner";
import { hashPassword, verifyPassword, type PasswordParams } from "./password";
import { hashRecoveryCode, looksLikeRecoveryCode } from "./recovery";
import { verifyTotp } from "./totp";

export const LIMITS = {
  failuresPerMinute: 5,
  lockoutBaseMs: 60_000,
  lockoutMaxMs: 24 * 3_600_000,
  userSecondFactorFailures: 10,
  userWindowMs: 3_600_000,
  reauthFailuresBeforeRevoke: 3,
  pendingTtlMs: 5 * 60_000,
  pendingMaxAttempts: 5,
  idleMs: 12 * 3_600_000,
  absoluteMs: 7 * 24 * 3_600_000,
  reauthWindowMs: 5 * 60_000,
  touchEveryMs: 60_000,
  concurrentHashes: 2,
  queuedHashes: 6,
  busyRetryMs: 1_000,
} as const;

/** Serialises every attempt reservation (a different key from the audit chain's lock). */
const ATTEMPT_LOCK = 7_731_002;

export interface AuthDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly sessionSecret: string;
  readonly passwordParams?: PasswordParams;
  /** Defaults to one process-wide gate. */
  readonly hashGate?: HashGate;
}

export type AuthError =
  | { readonly ok: false; readonly code: "UNAUTHENTICATED"; readonly message: string }
  | {
      readonly ok: false;
      readonly code: "RATE_LIMITED";
      readonly message: string;
      readonly retryAfterMs: number;
    };

export interface Session {
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
  readonly reauthAt: number | null;
}

const denied = (message = "Wrong password or code."): AuthError => ({
  ok: false,
  code: "UNAUTHENTICATED",
  message,
});
const limited = (retryAfterMs: number, message = "Too many attempts. Try again later."): AuthError => ({
  ok: false,
  code: "RATE_LIMITED",
  message,
  retryAfterMs,
});
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: Date | string | null): number | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).getTime();

const sharedGate = new HashGate(LIMITS.concurrentHashes, LIMITS.queuedHashes);
let dummyHash: Promise<string> | undefined;

function record(deps: AuthDeps, entry: AuditEntry, db: Db = deps.db): Promise<string> {
  return audit(db, auditKey(deps.sessionSecret), entry, new Date(deps.clock.now()));
}

/**
 * The key an IP is throttled under. IPv4 (and IPv4-mapped IPv6): the address. IPv6: its /64, because one subscriber
 * routinely owns a whole /64 and could otherwise rotate through 2^64 addresses. Anything unparseable: itself, bounded.
 */
export function ipKey(raw: string): string {
  const ip = raw.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)?.[1];
  if (mapped !== undefined && isIPv4(mapped)) return mapped;
  if (isIPv4(ip)) return ip;
  const bare = ip.split("%")[0] ?? ip;
  if (!isIPv6(bare) || bare.includes(".")) return ip.slice(0, 64);
  const [head = "", tail] = bare.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** How long this client network must wait, or 0. */
export async function lockoutRemaining(deps: AuthDeps, ip: string): Promise<number> {
  return networkWait(deps.db, ipKey(ip), deps.clock.now());
}

async function networkWait(db: Db, key: string, now: number): Promise<number> {
  // Only failures since this network's last complete login count: a few typos over a day shouldn't add up to a lockout.
  const [lastOk] = await db.query<{ at: Date | string }>(
    "select at from login_attempts where ip = $1 and ok = true and stage = 'totp' order by at desc limit 1",
    [key],
  );
  const since = Math.max(now - 24 * 3_600_000, ms(lastOk?.at ?? null) ?? 0);
  const rows = await db.query<{ at: Date | string }>(
    "select at from login_attempts where ip = $1 and ok = false and at > $2 order by at desc",
    [key, iso(since)],
  );
  const times = rows.map((r) => ms(r.at) ?? 0);
  const lastMinute = times.filter((t) => t > now - 60_000).length;
  const beyond = times.length - LIMITS.failuresPerMinute;
  if (beyond < 0 && lastMinute < LIMITS.failuresPerMinute) return 0;
  const last = times[0] ?? now;
  const lock = Math.min(LIMITS.lockoutBaseMs * 2 ** Math.max(0, beyond), LIMITS.lockoutMaxMs);
  return Math.max(0, last + lock - now);
}

/** How long until this account's second factor may be tried again, or 0. */
async function accountWait(db: Db, userId: string, now: number): Promise<number> {
  const [lastOk] = await db.query<{ at: Date | string }>(
    "select at from login_attempts where user_id = $1 and ok = true order by at desc limit 1",
    [userId],
  );
  const since = Math.max(now - LIMITS.userWindowMs, ms(lastOk?.at ?? null) ?? 0);
  const rows = await db.query<{ at: Date | string }>(
    "select at from login_attempts where user_id = $1 and ok = false and at > $2 order by at asc",
    [userId, iso(since)],
  );
  const over = rows.length - LIMITS.userSecondFactorFailures;
  if (over < 0) return 0;
  // The budget frees up when the failure that filled it ages out of the window.
  const pivot = ms(rows[over]?.at ?? null) ?? now;
  return Math.max(1, pivot + LIMITS.userWindowMs - now);
}

/**
 * Check the limits and record this attempt as a failure, atomically. Returns the row to flip to ok on success.
 * Nothing is verified until this returns ok: that ordering is the whole defence against parallel guessing.
 */
async function reserve(
  deps: AuthDeps,
  input: { readonly ip: string; readonly stage: "password" | "totp"; readonly userId?: string },
): Promise<{ readonly ok: true; readonly id: string } | AuthError> {
  const now = deps.clock.now();
  const key = ipKey(input.ip);
  return deps.db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock($1)", [ATTEMPT_LOCK]);
    const wait = Math.max(
      await networkWait(t, key, now),
      input.userId === undefined ? 0 : await accountWait(t, input.userId, now),
    );
    if (wait > 0) return limited(wait);
    const [row] = await t.query<{ id: string | number }>(
      "insert into login_attempts (ip, stage, ok, at, user_id) values ($1, $2, false, $3, $4) returning id",
      [key, input.stage, iso(now), input.userId ?? null],
    );
    return { ok: true as const, id: String(row?.id) };
  });
}

const markOk = (db: Db, attemptId: string) =>
  db.query("update login_attempts set ok = true where id = $1", [attemptId]);

/** Step 1. */
export async function passwordStep(
  deps: AuthDeps,
  input: { readonly password: string; readonly ip: string },
): Promise<{ readonly ok: true; readonly pendingToken: string } | AuthError> {
  const entered = (deps.hashGate ?? sharedGate).enter();
  if (entered === null) return limited(LIMITS.busyRetryMs, "Busy. Try again in a moment.");
  const release = await entered;
  try {
    const slot = await reserve(deps, { ip: input.ip, stage: "password" });
    if (!slot.ok) return slot;

    const [user] = await deps.db.query<{ id: string; password_hash: string }>(
      "select id, password_hash from users limit 1",
    );
    dummyHash ??= hashPassword("dummy-password-for-timing", deps.passwordParams);
    const good = await verifyPassword(user?.password_hash ?? (await dummyHash), input.password);
    if (user === undefined || !good) {
      await record(deps, { actor: `ip:${input.ip}`, action: "login.password_failed" });
      return denied();
    }
    const pendingToken = randomToken();
    await deps.db.tx(async (t) => {
      await markOk(t, slot.id);
      await t.query("insert into pending_logins (id_hash, user_id, expires_at) values ($1, $2, $3)", [
        sha256(pendingToken),
        user.id,
        iso(deps.clock.now() + LIMITS.pendingTtlMs),
      ]);
    });
    return { ok: true, pendingToken };
  } finally {
    release();
  }
}

/** Step 2: a TOTP code, or a one-time recovery code. */
export async function secondFactorStep(
  deps: AuthDeps,
  input: {
    readonly pendingToken: string;
    readonly code: string;
    readonly ip: string;
    readonly userAgent?: string;
  },
): Promise<
  { readonly ok: true; readonly sessionToken: string; readonly absoluteExpiresAt: number } | AuthError
> {
  const now = deps.clock.now();
  const pendingHash = sha256(input.pendingToken);
  // Spend one of this pending login's attempts up front, atomically: parallel requests can't share an attempt.
  const [pending] = await deps.db.query<{ user_id: string; attempts: number }>(
    "update pending_logins set attempts = attempts + 1 where id_hash = $1 and expires_at > $2 and attempts < $3 returning user_id, attempts",
    [pendingHash, iso(now), LIMITS.pendingMaxAttempts],
  );
  if (pending === undefined) return denied("Login expired. Start again.");

  const slot = await reserve(deps, { ip: input.ip, stage: "totp", userId: pending.user_id });
  if (!slot.ok) return slot;

  let method: "totp" | "recovery" | undefined;
  if (looksLikeRecoveryCode(input.code)) {
    const used = await deps.db.query<{ id: number }>(
      "update recovery_codes set used_at = $1 where user_id = $2 and code_hash = $3 and used_at is null returning id",
      [iso(now), pending.user_id, hashRecoveryCode(input.code)],
    );
    if (used.length > 0) method = "recovery";
  } else if (await acceptTotp(deps, pending.user_id, input.code)) {
    method = "totp";
  }

  if (method === undefined) {
    if (pending.attempts >= LIMITS.pendingMaxAttempts) {
      await deps.db.query("delete from pending_logins where id_hash = $1", [pendingHash]);
    }
    await record(deps, {
      actor: `ip:${input.ip}`,
      action: "login.second_factor_failed",
      subject: pending.user_id,
    });
    return denied();
  }

  const sessionToken = randomToken();
  const absoluteExpiresAt = now + LIMITS.absoluteMs;
  await deps.db.tx(async (t) => {
    await t.query("delete from pending_logins where id_hash = $1", [pendingHash]);
    await markOk(t, slot.id);
    await t.query(
      "insert into sessions (id_hash, user_id, created_at, last_seen_at, absolute_expires_at, reauth_at, ip, user_agent) values ($1, $2, $3, $3, $4, $3, $5, $6)",
      [
        sha256(sessionToken),
        pending.user_id,
        iso(now),
        iso(absoluteExpiresAt),
        input.ip,
        (input.userAgent ?? "").slice(0, 300),
      ],
    );
    const remaining =
      method === "recovery"
        ? (
            await t.query<{ n: number }>(
              "select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null",
              [pending.user_id],
            )
          )[0]?.n
        : undefined;
    await record(
      deps,
      {
        actor: "owner",
        action: method === "recovery" ? "login.ok_recovery_code" : "login.ok",
        subject: pending.user_id,
        details: { ip: input.ip, ...(remaining === undefined ? {} : { recoveryCodesLeft: remaining }) },
      },
      t,
    );
  });
  return { ok: true, sessionToken, absoluteExpiresAt };
}

/** Verify a TOTP and consume its step atomically (two parallel requests with the same code: only one wins). */
async function acceptTotp(deps: AuthDeps, userId: string, code: string): Promise<boolean> {
  const [u] = await deps.db.query<{ totp_secret_enc: string; totp_last_step: string | number }>(
    "select totp_secret_enc, totp_last_step from users where id = $1",
    [userId],
  );
  if (u === undefined) return false;
  const check = verifyTotp(
    openTotpSecret(u.totp_secret_enc, userId, deps.sessionSecret),
    code,
    deps.clock.now(),
    Number(u.totp_last_step),
  );
  if (!check.ok) return false;
  const won = await deps.db.query(
    "update users set totp_last_step = $1 where id = $2 and totp_last_step < $1 returning id",
    [check.step, userId],
  );
  return won.length === 1;
}

/** The session for a cookie token, or null. Slides the idle timeout (written at most once a minute). */
export async function validateSession(deps: AuthDeps, token: string | undefined): Promise<Session | null> {
  if (token === undefined || token === "") return null;
  const now = deps.clock.now();
  const idHash = sha256(token);
  const [s] = await deps.db.query<{
    user_id: string;
    created_at: Date | string;
    last_seen_at: Date | string;
    absolute_expires_at: Date | string;
    reauth_at: Date | string | null;
    revoked_at: Date | string | null;
  }>(
    "select user_id, created_at, last_seen_at, absolute_expires_at, reauth_at, revoked_at from sessions where id_hash = $1",
    [idHash],
  );
  // Missing or revoked: both end here (s?.revoked_at is undefined when there is no row).
  if (s?.revoked_at !== null) return null;
  const lastSeen = ms(s.last_seen_at) ?? 0;
  const absolute = ms(s.absolute_expires_at) ?? 0;
  if (now - lastSeen > LIMITS.idleMs || now >= absolute) return null;
  if (now - lastSeen >= LIMITS.touchEveryMs) {
    await deps.db.query("update sessions set last_seen_at = $1 where id_hash = $2", [iso(now), idHash]);
  }
  return {
    idHash,
    userId: s.user_id,
    createdAt: ms(s.created_at) ?? 0,
    absoluteExpiresAt: absolute,
    reauthAt: ms(s.reauth_at),
  };
}

export async function logout(deps: AuthDeps, token: string | undefined): Promise<void> {
  if (token === undefined || token === "") return;
  await deps.db.tx(async (t) => {
    const rows = await t.query<{ user_id: string }>(
      "update sessions set revoked_at = $1 where id_hash = $2 and revoked_at is null returning user_id",
      [iso(deps.clock.now()), sha256(token)],
    );
    if (rows[0] !== undefined) {
      await record(deps, { actor: "owner", action: "logout", subject: rows[0].user_id }, t);
    }
  });
}

/** "Sign out everywhere": every session of this user, the caller's included. Returns how many were live. */
export async function revokeAllSessions(deps: AuthDeps, session: Session, ip: string): Promise<number> {
  return deps.db.tx(async (t) => {
    const rows = await t.query<{ id_hash: string }>(
      "update sessions set revoked_at = $1 where user_id = $2 and revoked_at is null returning id_hash",
      [iso(deps.clock.now()), session.userId],
    );
    await t.query("delete from pending_logins where user_id = $1", [session.userId]);
    await record(
      deps,
      {
        actor: "owner",
        action: "sessions.revoked_all",
        subject: session.userId,
        details: { ip, count: rows.length },
      },
      t,
    );
    return rows.length;
  });
}

/** Sensitive changes (live on, kill switch off, caps) need a TOTP within the last 5 minutes. */
export function hasFreshReauth(session: Session, now: number): boolean {
  return session.reauthAt !== null && now - session.reauthAt <= LIMITS.reauthWindowMs;
}

export async function reauth(
  deps: AuthDeps,
  session: Session,
  code: string,
  ip: string,
): Promise<{ readonly ok: true } | AuthError> {
  const slot = await reserve(deps, { ip, stage: "totp", userId: session.userId });
  if (!slot.ok) return slot;
  const now = deps.clock.now();

  if (!(await acceptTotp(deps, session.userId, code))) {
    return deps.db.tx(async (t) => {
      const [s] = await t.query<{ reauth_failures: number }>(
        "update sessions set reauth_failures = reauth_failures + 1 where id_hash = $1 returning reauth_failures",
        [session.idHash],
      );
      const revoke = (s?.reauth_failures ?? 0) >= LIMITS.reauthFailuresBeforeRevoke;
      if (revoke) {
        await t.query("update sessions set revoked_at = $1 where id_hash = $2 and revoked_at is null", [
          iso(now),
          session.idHash,
        ]);
      }
      await record(
        deps,
        {
          actor: "owner",
          action: revoke ? "session.revoked_reauth_failures" : "reauth.failed",
          subject: session.userId,
          details: { ip },
        },
        t,
      );
      return denied(revoke ? "Too many wrong codes. Sign in again." : "Wrong code.");
    });
  }

  await deps.db.tx(async (t) => {
    await markOk(t, slot.id);
    await t.query("update sessions set reauth_at = $1, reauth_failures = 0 where id_hash = $2", [
      iso(now),
      session.idHash,
    ]);
    await record(deps, { actor: "owner", action: "reauth.ok", subject: session.userId }, t);
  });
  return { ok: true };
}
