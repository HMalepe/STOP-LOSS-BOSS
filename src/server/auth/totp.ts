/**
 * TOTP, RFC 6238 (HMAC-SHA1, 30 s, 6 digits), on node:crypto. Verified against the RFC's own test vectors.
 * Docs/05: ±1 step window. Replay protection: a step at or below the last accepted step is refused, so a code works once.
 */
import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "./crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret (RFC 4226 recommends ≥128), base32 for authenticator apps. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(epochMs: number): number {
  return Math.floor(epochMs / 1000 / STEP_SECONDS);
}

/** HOTP(secret, counter) with dynamic truncation, `digits` long. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

export function totpAt(secretBase32: string, epochMs: number): string {
  return hotp(base32Decode(secretBase32), stepAt(epochMs));
}

export type TotpCheck =
  | { readonly ok: true; readonly step: number }
  | { readonly ok: false; readonly reason: "invalid" | "replayed" };

/** Accepts the current step ±1. `lastStep`: the last step ever accepted for this user (replay protection). */
export function verifyTotp(secretBase32: string, code: string, epochMs: number, lastStep: number): TotpCheck {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false, reason: "invalid" };
  const secret = base32Decode(secretBase32);
  const now = stepAt(epochMs);
  for (const step of [now - 1, now, now + 1]) {
    if (safeEqual(hotp(secret, step), clean)) {
      return step <= lastStep ? { ok: false, reason: "replayed" } : { ok: true, step };
    }
  }
  return { ok: false, reason: "invalid" };
}

export function otpauthUrl(secretBase32: string, account: string, issuer = "Order Desk"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
