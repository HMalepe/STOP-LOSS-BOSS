/**
 * The single owner account (docs/05: seeded by CLI, no signup page). Creating it returns the TOTP secret and recovery codes
 * exactly once; only encrypted/hashed forms are stored.
 */
import { audit } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import { deriveKey, encrypt } from "./crypto";
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

export async function createOwner(
  db: Db,
  input: {
    readonly password: string;
    readonly sessionSecret: string;
    readonly replace?: boolean;
    readonly passwordParams?: PasswordParams;
  },
): Promise<OwnerSecrets> {
  const problem = passwordProblem(input.password);
  if (problem !== null) throw new OwnerError(`Password rejected: ${problem}.`);

  const existing = await db.query<{ id: string }>("select id from users");
  if (existing.length > 0 && input.replace !== true) {
    throw new OwnerError(
      "An owner already exists. Re-run with --replace to rotate the password, TOTP and recovery codes.",
    );
  }

  const totpSecret = newTotpSecret();
  const recoveryCodes = newRecoveryCodes();
  const passwordHash = await hashPassword(input.password, input.passwordParams);
  const sealed = encrypt(totpSecret, totpKey(input.sessionSecret));

  const userId = await db.tx(async (t) => {
    // Replacing = wiping every session and code that belonged to the old credentials.
    await t.query("delete from users");
    const [u] = await t.query<{ id: string }>(
      "insert into users (password_hash, totp_secret_enc) values ($1, $2) returning id",
      [passwordHash, sealed],
    );
    if (u === undefined) throw new OwnerError("could not create the owner");
    for (const code of recoveryCodes) {
      await t.query("insert into recovery_codes (user_id, code_hash) values ($1, $2)", [
        u.id,
        hashRecoveryCode(code),
      ]);
    }
    return u.id;
  });
  await audit(db, {
    actor: "cli",
    action: existing.length > 0 ? "owner.replaced" : "owner.created",
    subject: userId,
  });
  return { userId, totpSecret, otpauthUrl: otpauthUrl(totpSecret, "owner"), recoveryCodes };
}
