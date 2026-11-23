import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, canonical, GENESIS, verifyChain } from "@/server/audit/audit";
import { decrypt } from "@/server/auth/crypto";
import { createOwner, OwnerError, totpKey } from "@/server/auth/owner";
import { verifyPassword } from "@/server/auth/password";
import { hashRecoveryCode } from "@/server/auth/recovery";
import type { Db } from "@/server/db/sql";
import { testDb } from "../helpers/pglite";

const SECRET = "x".repeat(48);
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
let db: Db;
beforeEach(async () => {
  db = await testDb();
});
afterEach(async () => {
  await db.close();
});

describe("audit log: hash chain", () => {
  it("canonical JSON sorts keys at every level and drops undefined", () => {
    expect(canonical({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
    expect(canonical(undefined)).toBe("null");
  });

  it("each row links to the previous one; the chain verifies", async () => {
    const h1 = await audit(db, { actor: "owner", action: "login.ok" });
    const h2 = await audit(db, {
      actor: "owner",
      action: "plan.created",
      subject: "p1",
      details: { count: 214 },
    });
    const rows = await db.query<{ prev_hash: string; hash: string }>(
      "select prev_hash, hash from audit_log order by id",
    );
    expect(rows).toEqual([
      { prev_hash: GENESIS, hash: h1 },
      { prev_hash: h1, hash: h2 },
    ]);
    expect(await verifyChain(db)).toEqual({ ok: true, rows: 2 });
  });

  it("an empty log verifies", async () => {
    expect(await verifyChain(db)).toEqual({ ok: true, rows: 0 });
  });

  it("tampering is detected even by someone who can bypass the trigger (superuser)", async () => {
    await audit(db, { actor: "owner", action: "a" });
    await audit(db, { actor: "owner", action: "kill-switch.off", details: { by: "owner" } });
    await audit(db, { actor: "owner", action: "c" });
    await db.query("alter table audit_log disable trigger audit_log_no_update");
    await db.query('update audit_log set details = \'{"by":"someone else"}\'::jsonb where id = 2');
    expect(await verifyChain(db)).toEqual({
      ok: false,
      brokenAt: 2,
      reason: "row content does not match its hash",
    });
  });

  it("a deleted row is detected", async () => {
    for (const a of ["a", "b", "c"]) await audit(db, { actor: "owner", action: a });
    await db.query("alter table audit_log disable trigger audit_log_no_delete");
    await db.query("delete from audit_log where id = 2");
    expect(await verifyChain(db)).toEqual({
      ok: false,
      brokenAt: 3,
      reason: "prev_hash does not match the previous row",
    });
  });

  it("concurrent writes keep the chain linear", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => audit(db, { actor: "owner", action: `a${String(i)}` })),
    );
    expect(await verifyChain(db)).toEqual({ ok: true, rows: 10 });
  });
});

describe("owner account", () => {
  it("creates the owner with hashed password, encrypted TOTP, hashed recovery codes; secrets returned once", async () => {
    const o = await createOwner(db, {
      password: "a very good password",
      sessionSecret: SECRET,
      passwordParams: FAST,
    });
    const [u] = await db.query<{ password_hash: string; totp_secret_enc: string }>(
      "select password_hash, totp_secret_enc from users",
    );
    expect(await verifyPassword(u!.password_hash, "a very good password")).toBe(true);
    expect(u!.totp_secret_enc).not.toContain(o.totpSecret);
    expect(decrypt(u!.totp_secret_enc, totpKey(SECRET))).toBe(o.totpSecret);
    const codes = await db.query<{ code_hash: string }>("select code_hash from recovery_codes");
    expect(codes.map((c) => c.code_hash).sort()).toEqual(o.recoveryCodes.map(hashRecoveryCode).sort());
    expect(o.otpauthUrl).toContain(o.totpSecret);
    expect((await db.query<{ action: string }>("select action from audit_log")).map((r) => r.action)).toEqual(
      ["owner.created"],
    );
  });

  it("refuses a weak password and a second owner", async () => {
    await expect(createOwner(db, { password: "short", sessionSecret: SECRET })).rejects.toThrow(OwnerError);
    await createOwner(db, { password: "a very good password", sessionSecret: SECRET, passwordParams: FAST });
    await expect(
      createOwner(db, { password: "another good password", sessionSecret: SECRET, passwordParams: FAST }),
    ).rejects.toThrow(/already exists/);
  });

  it("--replace rotates everything and kills every old session", async () => {
    const first = await createOwner(db, {
      password: "a very good password",
      sessionSecret: SECRET,
      passwordParams: FAST,
    });
    await db.query("insert into sessions (id_hash, user_id, absolute_expires_at) values ('s1', $1, now())", [
      first.userId,
    ]);
    const second = await createOwner(db, {
      password: "a brand new password",
      sessionSecret: SECRET,
      replace: true,
      passwordParams: FAST,
    });
    expect(second.totpSecret).not.toBe(first.totpSecret);
    expect(await db.query("select * from sessions")).toEqual([]);
    expect(await db.query("select count(*)::int as n from users")).toEqual([{ n: 1 }]);
    expect(
      (await db.query<{ action: string }>("select action from audit_log order by id")).map((r) => r.action),
    ).toEqual(["owner.created", "owner.replaced"]);
  });
});
