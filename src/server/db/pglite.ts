/**
 * Embedded Postgres (PGlite): real Postgres semantics with zero setup. Used for tests (in memory) and for mock mode
 * (DATABASE_URL=pglite://<dir>, persisted to disk), so `pnpm dev` runs fully offline. Demo/live use Supabase.
 */
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./sql";

type Conn = PGlite | Parameters<Parameters<PGlite["transaction"]>[0]>[0];

function wrap(pg: Conn, root: PGlite, inTx: boolean): Db {
  const self: Db = {
    async query<T extends object>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      // Multi-statement text (migrations) has no params: run it as a script. Everything else is parameterised.
      if (params.length === 0 && text.includes(";")) {
        const results = await pg.exec(text);
        return (results.at(-1)?.rows ?? []) as T[];
      }
      return (await pg.query<T>(text, [...params])).rows;
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return inTx ? fn(self) : root.transaction((t) => fn(wrap(t, root, true)));
    },
    close: () => root.close(),
  };
  return self;
}

/** `dataDir` undefined = in memory. */
export function pgliteDb(dataDir?: string): Db {
  // PGlite won't create missing parents: a fresh clone has no .data/ yet.
  if (dataDir !== undefined) mkdirSync(dataDir, { recursive: true });
  const pg = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  return wrap(pg, pg, false);
}
