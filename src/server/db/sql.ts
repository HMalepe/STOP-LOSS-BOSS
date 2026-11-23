/**
 * The database seam. Production: Postgres (Supabase) via the `postgres` driver. Tests: PGlite (real Postgres in WASM), so
 * migrations, constraints and triggers are tested for real. All queries are parameterised ($1, $2…): no string building.
 */
export interface Db {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run fn in one transaction: all or nothing. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
