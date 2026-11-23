import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt, randomToken, safeEqual, sha256 } from "@/server/auth/crypto";
import { hashPassword, passwordProblem, verifyPassword } from "@/server/auth/password";
import {
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  normaliseRecoveryCode,
} from "@/server/auth/recovery";
import {
  base32Decode,
  base32Encode,
  hotp,
  newTotpSecret,
  otpauthUrl,
  stepAt,
  totpAt,
  verifyTotp,
} from "@/server/auth/totp";

const FAST = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

describe("crypto helpers", () => {
  const key = deriveKey("s".repeat(40), "totp-secret");

  it("AES-256-GCM round-trips, and every ciphertext is different (random IV)", () => {
    const a = encrypt("JBSWY3DPEHPK3PXP", key);
    const b = encrypt("JBSWY3DPEHPK3PXP", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("tampering or a wrong key fails loudly", () => {
    const sealed = encrypt("secret", key);
    const parts = sealed.split(".");
    const flipped = [parts[0], parts[1], parts[2], Buffer.from("garbage").toString("base64url")].join(".");
    expect(() => decrypt(flipped, key)).toThrow();
    expect(() => decrypt(sealed, deriveKey("s".repeat(40), "other-purpose"))).toThrow();
    expect(() => decrypt("v2.a.b.c", key)).toThrow("unreadable ciphertext");
    expect(() => decrypt("nonsense", key)).toThrow("unreadable ciphertext");
  });

  it("keys are purpose-bound", () => {
    expect(deriveKey("x".repeat(40), "a").equals(deriveKey("x".repeat(40), "b"))).toBe(false);
    expect(deriveKey("x".repeat(40), "a")).toHaveLength(32);
  });

  it("tokens are 256-bit url-safe; sha256 and constant-time compare behave", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("123456", "123456")).toBe(true);
    expect(safeEqual("123456", "123457")).toBe(false);
    expect(safeEqual("1234", "123456")).toBe(false);
  });
});

describe("passwords (argon2id)", () => {
  it("hash/verify round-trip; wrong password and malformed hash are false, never a throw", async () => {
    const h = await hashPassword("correct horse battery", FAST);
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "correct horse batterY")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });

  it("production parameters are above the OWASP minimum", async () => {
    const h = await hashPassword("a long enough password");
    expect(h).toMatch(/\$m=65536,t=3,p=1\$/);
  });

  it("policy: 12+ chars, no edge spaces", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem(" twelve chars ok")).toMatch(/spaces/);
    expect(passwordProblem("twelve chars ok")).toBeNull();
  });
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", last 6 of the 8-digit values.
  const SEED = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ])("RFC vector at T=%i → %s", (seconds, code) => {
    expect(totpAt(SEED, seconds * 1000)).toBe(code);
  });

  it("RFC 4226 HOTP vectors (counter 0..2)", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect([0, 1, 2].map((c) => hotp(secret, c))).toEqual(["755224", "287082", "359152"]);
  });

  it("base32 round-trips any bytes and ignores case, spaces, padding", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 40 }), (bytes) => {
        const buf = Buffer.from(bytes);
        expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
      }),
    );
    expect(base32Decode("jbsw y3dp=").equals(base32Decode("JBSWY3DP"))).toBe(true);
    expect(() => base32Decode("JBSW1")).toThrow("invalid base32");
  });

  it("accepts the current step ±1, rejects ±2", () => {
    const secret = newTotpSecret();
    const now = 1_763_769_600_000;
    for (const delta of [-30_000, 0, 30_000]) {
      expect(verifyTotp(secret, totpAt(secret, now + delta), now, 0).ok).toBe(true);
    }
    for (const delta of [-60_000, 60_000]) {
      expect(verifyTotp(secret, totpAt(secret, now + delta), now, 0)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("replay protection: a code works once (its step must be newer than the last accepted)", () => {
    const secret = newTotpSecret();
    const now = 1_763_769_600_000;
    const code = totpAt(secret, now);
    const first = verifyTotp(secret, code, now, 0);
    expect(first).toEqual({ ok: true, step: stepAt(now) });
    expect(verifyTotp(secret, code, now, first.ok ? first.step : 0)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("format: 6 digits, spaces allowed, anything else invalid", () => {
    const secret = newTotpSecret();
    const now = Date.now();
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now, 0).ok).toBe(true);
    for (const bad of ["12345", "1234567", "abcdef", ""]) {
      expect(verifyTotp(secret, bad, now, 0)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("secrets are 160-bit base32; otpauth URL has what authenticator apps need", () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    const url = new URL(otpauthUrl(s, "owner"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.searchParams.get("secret")).toBe(s);
    expect(url.searchParams.get("issuer")).toBe("Order Desk");
    expect(url.searchParams.get("period")).toBe("30");
  });
});

describe("recovery codes", () => {
  it("10 unique codes, XXXX-XXXX-XXXX, ~60 bits each", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("case, spaces and dashes don't matter; hashes are stable", () => {
    const [c] = newRecoveryCodes(1);
    const sloppy = ` ${c!.toLowerCase().replace(/-/g, " ")} `;
    expect(normaliseRecoveryCode(sloppy)).toBe(c!.replace(/-/g, ""));
    expect(hashRecoveryCode(sloppy)).toBe(hashRecoveryCode(c!));
    expect(looksLikeRecoveryCode(sloppy)).toBe(true);
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});
