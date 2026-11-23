/**
 * Passwords: argon2id (docs/05-SECURITY.md). Stronger than the OWASP minimum (19 MiB, t=2): one login a day can afford
 * ~150 ms; an attacker with a stolen hash pays that per guess.
 */
import { hash, verify } from "@node-rs/argon2";

export interface PasswordParams {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const PRODUCTION_PARAMS: PasswordParams = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `use at least ${String(MIN_PASSWORD_LENGTH)} characters`;
  if (password.trim() !== password) return "no leading or trailing spaces";
  return null;
}

export function hashPassword(password: string, params: PasswordParams = PRODUCTION_PARAMS): Promise<string> {
  // @node-rs/argon2 defaults to argon2id (asserted by a test: every hash starts with $argon2id$).
  return hash(password, { ...params });
}

/** False on mismatch or on a malformed hash, never throws. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}
