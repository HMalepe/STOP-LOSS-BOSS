/** A fresh in-memory Postgres with all migrations applied. */
import { migrate } from "@/server/db/migrate";
import { pgliteDb } from "@/server/db/pglite";
import type { Db } from "@/server/db/sql";

export async function testDb(): Promise<Db> {
  const db = pgliteDb();
  await migrate(db);
  return db;
}
