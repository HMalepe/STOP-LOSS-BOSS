/**
 * The single owner account (docs/05: seeded by CLI, no signup page). Creating it returns the TOTP secret and recovery codes
 * exactly once; only encrypted/hashed forms are stored.
 */
import { randomUUID } from "node:crypto";
import { audit, auditKey } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import { decrypt, deriveKey, encrypt } from "./crypto";
import { hashPassword, passwordProblem, type PasswordParams } from "./password";
import { hashRecoveryCode, newRecoveryCodes } from "./recovery";
import { newTotpSecret, otpauthUrl } from "./totp";

export interface OwnerSecrets {
  readonly userId: string;
  readonly totpSecret: string;
  readonly otpauthUrl: string;
  readonly recoveryCodes: readonly string[];
}

export class OwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerError";
  }
}

export function totpKey(sessionSecret: string): Buffer {
  return deriveKey(sessionSecret, "totp-secret");
}

/** The TOTP secret is sealed with the user id as AAD: copied onto another row, it no longer decrypts. */
export function sealTotpSecret(secret: string, userId: string, sessionSecret: string): string {
  return encrypt(secret, totpKey(sessionSecret), userId);
}
export function openTotpSecret(sealed: string, userId: string, sessionSecret: string): string {
  return decrypt(sealed, totpKey(sessionSecret), userId);
}

/**
 * Create the owner, or with `replace` rotate the existing one IN PLACE (same id, so nothing that references it is
 * touched): new password, new TOTP secret (replay counter reset), new recovery codes; every session revoked and every
 * half-finished login dropped. All in one transaction with its audit row.
 */
export async function createOwner(
  db: Db,
  input: {
    readonly password: string;
    readonly sessionSecret: string;
    readonly replace?: boolean;
    readonly passwordParams?: PasswordParams;
    readonly now?: Date;
  },
): Promise<OwnerSecrets> {
  const problem = passwordProblem(input.password);
  if (problem !== null) throw new OwnerError(`Password rejected: ${problem}.`);

  const existing = await db.query<{ id: string }>("select id from users order by created_at limit 2");
  if (existing.length > 1) {
    throw new OwnerError("More than one user row: refusing to guess which is the owner.");
  }
  const current = existing[0];
  if (current !== undefined && input.replace !== true) {
    throw new OwnerError(
      "An owner already exists. Re-run with --replace to rotate the password, TOTP and recovery codes.",
    );
  }

  const userId = current?.id ?? randomUUID();
  const totpSecret = newTotpSecret();
  const recoveryCodes = newRecoveryCodes();
  const passwordHash = await hashPassword(input.password, input.passwordParams);
  const sealed = sealTotpSecret(totpSecret, userId, input.sessionSecret);
  const now = input.now ?? new Date();

  await db.tx(async (t) => {
    if (current === undefined) {
      await t.query("insert into users (id, password_hash, totp_secret_enc) values ($1, $2, $3)", [
        userId,
        passwordHash,
        sealed,
      ]);
    } else {
      await t.query(
        "update users set password_hash = $1, totp_secret_enc = $2, totp_last_step = 0 where id = $3",
        [passwordHash, sealed, userId],
      );
      await t.query("delete from recovery_codes where user_id = $1", [userId]);
      await t.query("update sessions set revoked_at = $1 where user_id = $2 and revoked_at is null", [
        now.toISOString(),
        userId,
      ]);
      await t.query("delete from pending_logins where user_id = $1", [userId]);
    }
    for (const code of recoveryCodes) {
      await t.query("insert into recovery_codes (user_id, code_hash) values ($1, $2)", [
        userId,
        hashRecoveryCode(code),
      ]);
    }
    await audit(
      t,
      auditKey(input.sessionSecret),
      { actor: "cli", action: current === undefined ? "owner.created" : "owner.replaced", subject: userId },
      now,
    );
  });
  return { userId, totpSecret, otpauthUrl: otpauthUrl(totpSecret, "owner"), recoveryCodes };
}
