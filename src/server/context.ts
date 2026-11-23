/**
 * Process-wide services, created once and lazily: the database (migrated on first use) and the auth dependencies.
 * mock: embedded Postgres (pglite://<dir> or pglite://memory). demo/live: Supabase Postgres.
 */
import type { AuthDeps } from "./auth/login";
import { systemClock } from "./clock";
import { migrate } from "./db/migrate";
import { pgliteDb } from "./db/pglite";
import { postgresDb } from "./db/postgres";
import type { Db } from "./db/sql";
import { getEnv } from "./env";

/**
 * ONE database per process, on globalThis: Next builds API routes and pages as separate module graphs, so a module-level
 * `let` would open two databases (for embedded PGlite: two unrelated copies, and a session created by the login API
 * would be invisible to the desk page). Same pattern as the shared MetaApi connection.
 */
const KEY = "__orderDeskDb";
const g = globalThis as typeof globalThis & { [KEY]?: { db?: Promise<Db> | undefined } };
const shared = (g[KEY] ??= {});

export function pgliteDir(url: string): string | undefined {
  const rest = url.replace(/^pglite:(\/\/)?/, "");
  return rest === "" || rest === "memory" ? undefined : rest;
}

export function getDb(): Promise<Db> {
  shared.db ??= (async () => {
    const url = getEnv().DATABASE_URL;
    const conn = url.startsWith("pglite:") ? pgliteDb(pgliteDir(url)) : postgresDb(url);
    await migrate(conn);
    return conn;
  })().catch((e: unknown) => {
    shared.db = undefined;
    throw e;
  });
  return shared.db;
}

/** The database if it's already open; never opens one (shutdown must not connect just to close). */
export function startedDb(): Promise<Db> | undefined {
  return db;
}

export async function getAuthDeps(): Promise<AuthDeps> {
  return { db: await getDb(), clock: systemClock, sessionSecret: getEnv().SESSION_SECRET };
}
