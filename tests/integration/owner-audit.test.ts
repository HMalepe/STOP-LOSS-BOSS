import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, auditKey, canonical, GENESIS, rowHash, verifyChain } from "@/server/audit/audit";
import { sha256 } from "@/server/auth/crypto";
import { createOwner, openTotpSecret, OwnerError, sealTotpSecret } from "@/server/auth/owner";
import { verifyPassword } from "@/server/auth/password";
import { hashRecoveryCode } from "@/server/auth/recovery";
import type { Db } from "@/server/db/sql";
import { testDb } from "../helpers/pglite";

const SECRET = "x".repeat(48);
const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };
const KEY = auditKey(SECRET);
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
    const h1 = await audit(db, KEY, { actor: "owner", action: "login.ok" });
    const h2 = await audit(db, KEY, {
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
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 2 });
  });

  it("an empty log verifies", async () => {
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 0 });
  });

  it("tampering is detected even by someone who can bypass the trigger (superuser)", async () => {
    await audit(db, KEY, { actor: "owner", action: "a" });
    await audit(db, KEY, { actor: "owner", action: "kill-switch.off", details: { by: "owner" } });
    await audit(db, KEY, { actor: "owner", action: "c" });
    await db.query("alter table audit_log disable trigger audit_log_no_update");
    await db.query('update audit_log set details = \'{"by":"someone else"}\'::jsonb where id = 2');
    expect(await verifyChain(db, KEY)).toEqual({
      ok: false,
      brokenAt: 2,
      reason: "row content does not match its hash",
    });
  });

  it("a deleted row is detected", async () => {
    for (const a of ["a", "b", "c"]) await audit(db, KEY, { actor: "owner", action: a });
    await db.query("alter table audit_log disable trigger audit_log_no_delete");
    await db.query("delete from audit_log where id = 2");
    expect(await verifyChain(db, KEY)).toEqual({
      ok: false,
      brokenAt: 3,
      reason: "prev_hash does not match the previous row",
    });
  });

  it("a rewritten history re-chained WITHOUT the key is detected (a db owner can't forge the HMAC)", async () => {
    for (const a of ["a", "b"]) await audit(db, KEY, { actor: "owner", action: a });
    await db.query("alter table audit_log disable trigger audit_log_no_update");
    // The attacker edits row 2 and recomputes its hash the only ways they can: plain sha256, or a guessed key.
    const [r1] = await db.query<{ hash: string }>("select hash from audit_log where id = 1");
    const row = { at: "2026-01-01T00:00:00.000Z", actor: "owner", action: "x", subject: null, details: {} };
    for (const forged of [
      sha256(`${r1!.hash}|${canonical(row)}`),
      rowHash(auditKey("q".repeat(48)), r1!.hash, row),
    ]) {
      await db.query("update audit_log set at = $1, action = 'x', hash = $2 where id = 2", [row.at, forged]);
      expect(await verifyChain(db, KEY)).toMatchObject({ ok: false, brokenAt: 2 });
    }
    // And with the real key the same rewrite would verify: the key is what protects the chain.
    await db.query("update audit_log set hash = $1 where id = 2", [rowHash(KEY, r1!.hash, row)]);
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 2 });
  });

  it("details are hashed exactly as jsonb stores them (Dates, undefined, nested)", async () => {
    await audit(db, KEY, {
      actor: "owner",
      action: "x",
      details: { when: new Date("2026-11-23T10:00:00Z"), gone: undefined, n: { z: 1, a: [1, "2"] } },
    });
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 1 });
    expect(await db.query("select details from audit_log")).toEqual([
      { details: { when: "2026-11-23T10:00:00.000Z", n: { z: 1, a: [1, "2"] } } },
    ]);
  });

  it("inside a transaction, the audit row commits or rolls back WITH the change", async () => {
    await expect(
      db.tx(async (t) => {
        await t.query("insert into config (key, value) values ('k', '{}')");
        await audit(t, KEY, { actor: "owner", action: "should.vanish" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.query("select * from config")).toEqual([]);
    expect(await db.query("select * from audit_log")).toEqual([]);
    await db.tx(async (t) => {
      await t.query("insert into config (key, value) values ('k', '{}')");
      await audit(t, KEY, { actor: "owner", action: "kept" });
    });
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 1 });
  });

  it("concurrent writes keep the chain linear", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => audit(db, KEY, { actor: "owner", action: `a${String(i)}` })),
    );
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 10 });
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
    expect(openTotpSecret(u!.totp_secret_enc, o.userId, SECRET)).toBe(o.totpSecret);
    // Bound to its row (AAD = user id) and to the app secret.
    expect(() =>
      openTotpSecret(u!.totp_secret_enc, "00000000-0000-4000-8000-000000000000", SECRET),
    ).toThrow();
    expect(() => openTotpSecret(u!.totp_secret_enc, o.userId, "z".repeat(48))).toThrow();
    expect(openTotpSecret(sealTotpSecret("ABC", "u1", SECRET), "u1", SECRET)).toBe("ABC");
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

  it("--replace rotates IN PLACE: same id, new secrets, every session revoked, references intact", async () => {
    const first = await createOwner(db, {
      password: "a very good password",
      sessionSecret: SECRET,
      passwordParams: FAST,
    });
    await db.query("update users set totp_last_step = 99999999 where id = $1", [first.userId]);
    await db.query("insert into sessions (id_hash, user_id, absolute_expires_at) values ('s1', $1, now())", [
      first.userId,
    ]);
    await db.query("insert into pending_logins (id_hash, user_id, expires_at) values ('p1', $1, now())", [
      first.userId,
    ]);
    // Rows that reference the owner: the old delete-and-recreate broke on these foreign keys (security review HIGH 3).
    await db.query("insert into config (key, value, updated_by) values ('kill_switch', '{}', $1)", [
      first.userId,
    ]);
    const at = new Date("2026-11-23T12:00:00Z");
    const second = await createOwner(db, {
      password: "a brand new password",
      sessionSecret: SECRET,
      replace: true,
      passwordParams: FAST,
      now: at,
    });
    expect(second.userId).toBe(first.userId);
    expect(second.totpSecret).not.toBe(first.totpSecret);
    expect(second.recoveryCodes).not.toEqual(first.recoveryCodes);
    const [u] = await db.query<{ password_hash: string; totp_last_step: string; totp_secret_enc: string }>(
      "select password_hash, totp_last_step, totp_secret_enc from users",
    );
    expect(await verifyPassword(u!.password_hash, "a brand new password")).toBe(true);
    expect(await verifyPassword(u!.password_hash, "a very good password")).toBe(false);
    expect(Number(u!.totp_last_step)).toBe(0); // a fresh secret starts a fresh replay counter
    expect(openTotpSecret(u!.totp_secret_enc, first.userId, SECRET)).toBe(second.totpSecret);
    expect(
      (await db.query<{ code_hash: string }>("select code_hash from recovery_codes"))
        .map((c) => c.code_hash)
        .sort(),
    ).toEqual(second.recoveryCodes.map(hashRecoveryCode).sort());
    // Revoked, not deleted: the forensic trail survives.
    expect(await db.query("select id_hash, revoked_at from sessions")).toEqual([
      { id_hash: "s1", revoked_at: at },
    ]);
    expect(await db.query("select * from pending_logins")).toEqual([]);
    expect(await db.query("select count(*)::int as n from config")).toEqual([{ n: 1 }]);
    expect(
      (await db.query<{ action: string }>("select action from audit_log order by id")).map((r) => r.action),
    ).toEqual(["owner.created", "owner.replaced"]);
    expect(await verifyChain(db, KEY)).toEqual({ ok: true, rows: 2 });
  });

  it("refuses to guess when there is more than one user row", async () => {
    await createOwner(db, { password: "a very good password", sessionSecret: SECRET, passwordParams: FAST });
    await db.query("insert into users (password_hash, totp_secret_enc) values ('x', 'y')");
    await expect(
      createOwner(db, {
        password: "a very good password",
        sessionSecret: SECRET,
        replace: true,
        passwordParams: FAST,
      }),
    ).rejects.toThrow(/more than one/i);
  });
});
