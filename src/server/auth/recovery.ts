/**
 * 10 one-time recovery codes (docs/05). 60 random bits each, so a plain SHA-256 is enough to store them (no slow hash
 * needed for high-entropy secrets). Shown once at enrolment, then only their hashes exist.
 */
import { randomBytes } from "node:crypto";
import { sha256 } from "./crypto";
import { base32Encode } from "./totp";

export const RECOVERY_CODE_COUNT = 10;

/** Format XXXX-XXXX-XXXX (base32, no look-alike problems beyond what base32 already avoids). */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

/** Case, spaces and dashes don't matter when typing a code. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return sha256(`recovery:${normaliseRecoveryCode(code)}`);
}

export function looksLikeRecoveryCode(code: string): boolean {
  return normaliseRecoveryCode(code).length === 12;
}
