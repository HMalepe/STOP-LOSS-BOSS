/** Db over the `postgres` driver (Supabase pooler or direct). One pool per process. */
import postgres from "postgres";
import type { Db } from "./sql";

type Sql = postgres.Sql | postgres.TransactionSql;

function wrap(sql: Sql, root: postgres.Sql, inTx: boolean): Db {
  const self: Db = {
    async query<T extends object>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      return inTx ? fn(self) : root.begin((t) => fn(wrap(t, root, true)));
    },
    close: () => root.end(),
  };
  return self;
}

export function postgresDb(url: string, opts: { readonly max?: number } = {}): Db {
  const root = postgres(url, {
    max: opts.max ?? 5,
    // Supabase's transaction pooler doesn't support prepared statements.
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    // Never print connection details or parameters on errors.
    onnotice: () => undefined,
  });
  return wrap(root, root, false);
}
