> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 05: Auth and security
Read: docs/05-SECURITY.md fully.

**M1. Database.** Supabase migrations for every table in 02 plus presets and config; RLS making audit_log append-only. /checkpoint.
**M2. Owner + password.** argon2id, `pnpm seed:owner` (prompts for a password, shows a TOTP QR in the terminal, prints recovery codes once). /checkpoint.
**M3. Login flow.** Password, then TOTP; recovery codes; sessions per spec; rate limit and lockout. /checkpoint.
**M4. Guards.** Middleware on /api, origin check on POST, kill switch service, trading-mode + live_enabled guard, re-auth for sensitive changes. /checkpoint.
**M5. Audit + headers.** Audit writer, CSP and security headers, logger redaction verified. /checkpoint.

Tests: everything in 05 plus the kill-switch matrix (blocked vs close-now allowed). Phase end: security-engineer agent, fix all critical and high findings. /handoff.
