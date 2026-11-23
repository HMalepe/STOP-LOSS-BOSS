/** A fresh real Postgres (PGlite, in memory) with all migrations applied. Tests only. */
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/sql";

function wrap(pg: PGlite | Parameters<Parameters<PGlite["transaction"]>[0]>[0], root: PGlite): Db {
  return {
    async query<T extends object>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      // Multi-statement text (migrations) has no params: use exec. Everything else is a parameterised query.
      if (params.length === 0 && text.includes(";")) {
        const results = await pg.exec(text);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await pg.query<T>(text, [...params])).rows;
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return root.transaction((t) => fn(wrap(t, root)));
    },
    close: () => root.close(),
  };
}

export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  const db = wrap(pg, pg);
  await migrate(db);
  return db;
}
