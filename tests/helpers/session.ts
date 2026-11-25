/** A signed-in owner on a fresh embedded database, for route tests. */
import { ManualClock } from "@/domain/clock";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { HashGate } from "@/server/auth/hashGate";
import { passwordStep, secondFactorStep, type AuthDeps } from "@/server/auth/login";
import { createOwner, type OwnerSecrets } from "@/server/auth/owner";
import { totpAt } from "@/server/auth/totp";
import type { Db } from "@/server/db/sql";
import { makeGuard } from "@/server/http/guard";
import { testDb } from "./pglite";

export const ORIGIN = "https://desk.example.com";
const SECRET = "t".repeat(48);
const PASSWORD = "a very good password";
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

export interface SignedIn {
  readonly db: Db;
  readonly clock: ManualClock;
  readonly deps: AuthDeps;
  readonly owner: OwnerSecrets;
  readonly cookie: string;
  readonly guard: ReturnType<typeof makeGuard>;
}

export async function signedIn(start = Date.parse("2026-11-23T10:00:05Z")): Promise<SignedIn> {
  const db = await testDb();
  const clock = new ManualClock(start);
  const deps: AuthDeps = {
    db,
    clock,
    sessionSecret: SECRET,
    passwordParams: FAST,
    hashGate: new HashGate(4, 4),
  };
  const owner = await createOwner(db, { password: PASSWORD, sessionSecret: SECRET, passwordParams: FAST });
  const s1 = await passwordStep(deps, { password: PASSWORD, ip: "198.51.100.1" });
  if (!s1.ok) throw new Error("setup");
  const s2 = await secondFactorStep(deps, {
    pendingToken: s1.pendingToken,
    code: totpAt(owner.totpSecret, clock.now()),
    ip: "198.51.100.1",
  });
  if (!s2.ok) throw new Error("setup");
  const guard = makeGuard(
    () => Promise.resolve(deps),
    () => ({ appOrigin: ORIGIN }),
  );
  return { db, clock, deps, owner, cookie: `${SESSION_COOKIE}=${s2.sessionToken}`, guard };
}

export function get(path: string, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: cookie === undefined ? {} : { cookie } });
}

export function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

/** Same as post() for any method (PUT, DELETE). */
export function send(
  method: "PUT" | "DELETE" | "PATCH",
  path: string,
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}
