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

let db: Promise<Db> | undefined;

export function pgliteDir(url: string): string | undefined {
  const rest = url.replace(/^pglite:(\/\/)?/, "");
  return rest === "" || rest === "memory" ? undefined : rest;
}

export function getDb(): Promise<Db> {
  db ??= (async () => {
    const url = getEnv().DATABASE_URL;
    const conn = url.startsWith("pglite:") ? pgliteDb(pgliteDir(url)) : postgresDb(url);
    await migrate(conn);
    return conn;
  })().catch((e: unknown) => {
    db = undefined;
    throw e;
  });
  return db;
}

/** The database if it's already open; never opens one (shutdown must not connect just to close). */
export function startedDb(): Promise<Db> | undefined {
  return db;
}

export async function getAuthDeps(): Promise<AuthDeps> {
  return { db: await getDb(), clock: systemClock, sessionSecret: getEnv().SESSION_SECRET };
}
