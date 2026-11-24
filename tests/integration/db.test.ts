import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/sql";
import { testDb } from "../helpers/pglite";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

async function user(): Promise<string> {
  const [u] = await db.query<{ id: string }>(
    "insert into users (password_hash, totp_secret_enc) values ('h', 'e') returning id",
  );
  return u!.id;
}

describe("migrations", () => {
  it("apply once; a second run applies nothing", async () => {
    expect(await migrate(db)).toEqual([]);
    const rows = await db.query<{ name: string }>("select name from schema_migrations");
    expect(rows.map((r) => r.name)).toEqual([
      "0001_init.sql",
      "0002_security_hardening.sql",
      "0003_plan_summary.sql",
      "0004_batch_seq.sql",
    ]);
  });

  it("row-level security is ON for every table (Supabase's public keys read nothing)", async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'",
    );
    expect(rows.length).toBe(12);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });
});

describe("audit_log is append-only (CLAUDE.md non-negotiable 4)", () => {
  beforeEach(async () => {
    await db.query(
      "insert into audit_log (actor, action, prev_hash, hash) values ('owner', 'login', 'genesis', 'h1')",
    );
  });

  it("insert works", async () => {
    expect(await db.query("select action from audit_log")).toEqual([{ action: "login" }]);
  });

  it.each([
    ["update", "update audit_log set action = 'nothing to see'"],
    ["delete", "delete from audit_log"],
    ["truncate", "truncate audit_log"],
  ])("%s is refused, even for the table owner", async (_n, sql) => {
    await expect(db.query(sql, [])).rejects.toThrow(/append-only/);
    expect(await db.query("select count(*)::int as n from audit_log")).toEqual([{ n: 1 }]);
  });

  it("hashes are unique (a chain can't fork silently)", async () => {
    await expect(
      db.query("insert into audit_log (actor, action, prev_hash, hash) values ('x', 'y', 'h1', $1)", ["h1"]),
    ).rejects.toThrow();
  });
});

describe("constraints that protect money", () => {
  it("one execution per plan, enforced by the database (non-negotiable 7)", async () => {
    const uid = await user();
    await db.query(
      "insert into plans (id, user_id, action, params, items, input_hash, expires_at) values ('p1', $1, 'levels', '{}', '[]', 'x', now())",
      [uid],
    );
    await db.query("insert into executions (id, plan_id) values (gen_random_uuid(), 'p1')");
    await expect(
      db.query("insert into executions (id, plan_id) values (gen_random_uuid(), 'p1')"),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("states are checked", async () => {
    const uid = await user();
    await expect(
      db.query(
        "insert into plans (id, user_id, action, params, items, input_hash, expires_at, status) values ('p2', $1, 'x', '{}', '[]', 'x', now(), 'maybe')",
        [uid],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query("insert into login_attempts (ip, stage, ok) values ('1.2.3.4', 'guess', false)"),
    ).rejects.toThrow(/check/i);
  });

  it("live is off by default on a new account", async () => {
    const [a] = await db.query<{ live_enabled: boolean }>(
      "insert into accounts (metaapi_account_id) values ('m1') returning live_enabled",
    );
    expect(a?.live_enabled).toBe(false);
  });

  it("deleting a user removes their sessions and recovery codes", async () => {
    const uid = await user();
    await db.query("insert into sessions (id_hash, user_id, absolute_expires_at) values ('s', $1, now())", [
      uid,
    ]);
    await db.query("insert into recovery_codes (user_id, code_hash) values ($1, 'c')", [uid]);
    await db.query("delete from users where id = $1", [uid]);
    expect(await db.query("select * from sessions")).toEqual([]);
    expect(await db.query("select * from recovery_codes")).toEqual([]);
  });

  it("transactions are all-or-nothing", async () => {
    await expect(
      db.tx(async (t) => {
        await t.query("insert into accounts (metaapi_account_id) values ('tx1')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select * from accounts where metaapi_account_id = 'tx1'")).toEqual([]);
  });
});

describe("embedded database on disk", () => {
  it("creates its directory on a fresh clone (no .data/ yet)", async () => {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const path = await import("node:path");
    const join = (...parts: string[]) => path.join(...parts);
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "od-"));
    const dir = join(root, "nested", "order-desk");
    const { pgliteDb } = await import("@/server/db/pglite");
    const db = pgliteDb(dir);
    expect(await db.query("select 1 as one")).toEqual([{ one: 1 }]);
    await db.close();
    expect(existsSync(dir)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
