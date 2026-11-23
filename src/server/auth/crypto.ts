/**
 * Small, boring crypto helpers on node:crypto. Nothing custom: AES-256-GCM, HKDF-SHA256, SHA-256, CSPRNG tokens,
 * constant-time comparison.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** 256-bit random token, URL-safe. Session ids, pending-login ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A purpose-bound 32-byte key from the app secret, so one secret never serves two jobs. */
export function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("order-desk", "utf8"),
      Buffer.from(purpose, "utf8"),
      32,
    ),
  );
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). Tampering fails decryption. */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

export function decrypt(sealed: string, key: Buffer): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || iv === undefined || tag === undefined || body === undefined) {
    throw new Error("unreadable ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** Constant-time string equality (for codes and hashes). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
