/**
 * Login (docs/05-SECURITY.md): password → TOTP (or a recovery code) → session.
 * - Rate limit per IP: 5 failures/minute, then exponential lockout (1 min, 2, 4… capped 24 h).
 *   Deliberately NOT a global account lockout: with one owner, that would let anyone lock the owner out.
 * - Timing: a wrong password and a missing account take the same time (a dummy hash is always verified).
 * - Step 1 hands out a short-lived single-use pending token; step 2 turns it into a session. Both stored hashed.
 * - Sessions: 256-bit random id, 12 h idle, 7 d absolute; a fresh TOTP counts as re-auth for sensitive changes.
 * Every outcome is audited (never with secrets).
 */
import type { Clock } from "@/domain/clock";
import { audit } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import { decrypt, randomToken, sha256 } from "./crypto";
import { totpKey } from "./owner";
import { hashPassword, verifyPassword, type PasswordParams } from "./password";
import { hashRecoveryCode, looksLikeRecoveryCode } from "./recovery";
import { verifyTotp } from "./totp";

export const LIMITS = {
  failuresPerMinute: 5,
  lockoutBaseMs: 60_000,
  lockoutMaxMs: 24 * 3_600_000,
  pendingTtlMs: 5 * 60_000,
  pendingMaxAttempts: 5,
  idleMs: 12 * 3_600_000,
  absoluteMs: 7 * 24 * 3_600_000,
  reauthWindowMs: 5 * 60_000,
  touchEveryMs: 60_000,
} as const;

export interface AuthDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly sessionSecret: string;
  readonly passwordParams?: PasswordParams;
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
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: Date | string | null): number | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).getTime();

let dummyHash: Promise<string> | undefined;

/** How long this IP must wait, or 0. */
export async function lockoutRemaining(deps: AuthDeps, ip: string): Promise<number> {
  const now = deps.clock.now();
  // Only failures since this IP's last complete login count: a few typos over a day shouldn't add up to a lockout.
  const [lastOk] = await deps.db.query<{ at: Date | string }>(
    "select at from login_attempts where ip = $1 and ok = true and stage = 'totp' order by at desc limit 1",
    [ip],
  );
  const since = Math.max(now - 24 * 3_600_000, ms(lastOk?.at ?? null) ?? 0);
  const rows = await deps.db.query<{ at: Date | string }>(
    "select at from login_attempts where ip = $1 and ok = false and at > $2 order by at desc",
    [ip, iso(since)],
  );
  const times = rows.map((r) => ms(r.at) ?? 0);
  const lastMinute = times.filter((t) => t > now - 60_000).length;
  const beyond = times.length - LIMITS.failuresPerMinute;
  if (beyond < 0 && lastMinute < LIMITS.failuresPerMinute) return 0;
  const last = times[0] ?? now;
  const lock = Math.min(LIMITS.lockoutBaseMs * 2 ** Math.max(0, beyond), LIMITS.lockoutMaxMs);
  return Math.max(0, last + lock - now);
}

async function recordAttempt(
  deps: AuthDeps,
  ip: string,
  stage: "password" | "totp",
  ok: boolean,
): Promise<void> {
  await deps.db.query("insert into login_attempts (ip, stage, ok, at) values ($1, $2, $3, $4)", [
    ip,
    stage,
    ok,
    iso(deps.clock.now()),
  ]);
}

async function rateLimited(deps: AuthDeps, ip: string): Promise<AuthError | null> {
  const wait = await lockoutRemaining(deps, ip);
  if (wait === 0) return null;
  return {
    ok: false,
    code: "RATE_LIMITED",
    message: "Too many attempts. Try again later.",
    retryAfterMs: wait,
  };
}

/** Step 1. */
export async function passwordStep(
  deps: AuthDeps,
  input: { readonly password: string; readonly ip: string },
): Promise<{ readonly ok: true; readonly pendingToken: string } | AuthError> {
  const limited = await rateLimited(deps, input.ip);
  if (limited !== null) return limited;

  const [user] = await deps.db.query<{ id: string; password_hash: string }>(
    "select id, password_hash from users limit 1",
  );
  dummyHash ??= hashPassword("dummy-password-for-timing", deps.passwordParams);
  const good = await verifyPassword(user?.password_hash ?? (await dummyHash), input.password);
  if (user === undefined || !good) {
    await recordAttempt(deps, input.ip, "password", false);
    await audit(
      deps.db,
      { actor: `ip:${input.ip}`, action: "login.password_failed" },
      new Date(deps.clock.now()),
    );
    return denied();
  }
  await recordAttempt(deps, input.ip, "password", true);
  const pendingToken = randomToken();
  await deps.db.query("insert into pending_logins (id_hash, user_id, expires_at) values ($1, $2, $3)", [
    sha256(pendingToken),
    user.id,
    iso(deps.clock.now() + LIMITS.pendingTtlMs),
  ]);
  return { ok: true, pendingToken };
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
  const limited = await rateLimited(deps, input.ip);
  if (limited !== null) return limited;
  const now = deps.clock.now();
  const pendingHash = sha256(input.pendingToken);
  const [pending] = await deps.db.query<{ user_id: string; expires_at: Date | string; attempts: number }>(
    "select user_id, expires_at, attempts from pending_logins where id_hash = $1",
    [pendingHash],
  );
  if (pending === undefined || (ms(pending.expires_at) ?? 0) <= now) {
    return denied("Login expired. Start again.");
  }

  const fail = async (): Promise<AuthError> => {
    await recordAttempt(deps, input.ip, "totp", false);
    await deps.db.query("update pending_logins set attempts = attempts + 1 where id_hash = $1", [
      pendingHash,
    ]);
    if (pending.attempts + 1 >= LIMITS.pendingMaxAttempts) {
      await deps.db.query("delete from pending_logins where id_hash = $1", [pendingHash]);
    }
    await audit(
      deps.db,
      { actor: `ip:${input.ip}`, action: "login.second_factor_failed", subject: pending.user_id },
      new Date(now),
    );
    return denied();
  };

  let method: "totp" | "recovery";
  if (looksLikeRecoveryCode(input.code)) {
    const used = await deps.db.query<{ id: number }>(
      "update recovery_codes set used_at = $1 where user_id = $2 and code_hash = $3 and used_at is null returning id",
      [iso(now), pending.user_id, hashRecoveryCode(input.code)],
    );
    if (used.length === 0) return fail();
    method = "recovery";
  } else {
    const ok = await acceptTotp(deps, pending.user_id, input.code);
    if (!ok) return fail();
    method = "totp";
  }

  await deps.db.query("delete from pending_logins where id_hash = $1", [pendingHash]);
  await recordAttempt(deps, input.ip, "totp", true);
  const sessionToken = randomToken();
  const absoluteExpiresAt = now + LIMITS.absoluteMs;
  await deps.db.query(
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
          await deps.db.query<{ n: number }>(
            "select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null",
            [pending.user_id],
          )
        )[0]?.n
      : undefined;
  await audit(
    deps.db,
    {
      actor: "owner",
      action: method === "recovery" ? "login.ok_recovery_code" : "login.ok",
      subject: pending.user_id,
      details: { ip: input.ip, ...(remaining === undefined ? {} : { recoveryCodesLeft: remaining }) },
    },
    new Date(now),
  );
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
    decrypt(u.totp_secret_enc, totpKey(deps.sessionSecret)),
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
  const rows = await deps.db.query<{ user_id: string }>(
    "update sessions set revoked_at = $1 where id_hash = $2 and revoked_at is null returning user_id",
    [iso(deps.clock.now()), sha256(token)],
  );
  if (rows[0] !== undefined) {
    await audit(
      deps.db,
      { actor: "owner", action: "logout", subject: rows[0].user_id },
      new Date(deps.clock.now()),
    );
  }
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
  const limited = await rateLimited(deps, ip);
  if (limited !== null) return limited;
  if (!(await acceptTotp(deps, session.userId, code))) {
    await recordAttempt(deps, ip, "totp", false);
    await audit(
      deps.db,
      { actor: "owner", action: "reauth.failed", subject: session.userId },
      new Date(deps.clock.now()),
    );
    return denied("Wrong code.");
  }
  await deps.db.query("update sessions set reauth_at = $1 where id_hash = $2", [
    iso(deps.clock.now()),
    session.idHash,
  ]);
  await audit(
    deps.db,
    { actor: "owner", action: "reauth.ok", subject: session.userId },
    new Date(deps.clock.now()),
  );
  return { ok: true };
}
