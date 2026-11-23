/** The e2e owner (a throwaway embedded database, seeded by scripts/e2e-seed.ts before the server starts). */
export const E2E_PASSWORD = "e2e owner password 2026";
/** Base32 (RFC 4648), 160 bits. Only ever used against .data/e2e. */
export const E2E_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const E2E_SESSION_SECRET = "e2e-only-session-secret-0123456789abcdef";
export const E2E_DB_DIR = ".data/e2e";
export const E2E_RECOVERY_FILE = ".data/e2e-recovery.json";
