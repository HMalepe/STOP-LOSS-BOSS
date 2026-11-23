# 05: Security

This app can move real money. Threat model: stolen phone, leaked URL, leaked password, malicious request replay, our own bugs.

## Auth
- Single owner account seeded via CLI script (`pnpm seed:owner`), not a signup page.
- Password hashed with argon2id. Login rate-limited (5/min/IP, then exponential lockout).
- **TOTP 2FA required** (RFC 6238, 30s, ±1 window). Enrolment via QR on first login. 10 one-time recovery codes, hashed.
- Session: random 256-bit id, httpOnly, Secure, SameSite=Strict cookie, 12h idle timeout, 7d absolute. Stored hashed in DB.
- Re-auth (TOTP) required to: switch account to live, disable the kill switch, change caps.

## Secrets
- Env validated by Zod at boot (`src/server/env.ts`); the app refuses to start if anything is missing.
- MT login/password are entered in the MetaApi dashboard, never in our app or env. We hold only `METAAPI_TOKEN`.
- Never log tokens, cookies, or full request bodies of auth routes. Redact in the logger.

## Trading safety
- `TRADING_MODE` env: `mock` (default) | `demo` | `live`. `live` additionally needs `accounts.live_enabled = true`.
- Kill switch: env `TRADING_HALTED=1` OR DB flag. Blocks all mutating actions except close-now.
- Caps (DB config, re-auth to change): max orders per action, max total lots per action, max positions per modify batch.
- Plans are single-use (DB unique constraint on executions.plan_id) and expire in 30s.
- CSRF: SameSite=Strict + verify `Origin` header on every POST.
- Security headers: strict CSP (no inline script; nonce if needed), HSTS, frame-ancestors none, referrer no-referrer.

## Audit
Append-only table, RLS forbids update/delete for the app role. Every login, failed login, plan, execution, item result, kill-switch change, and mode change.

## As built (Phase 05)
| Threat / requirement | Where |
|---|---|
| Owner seeded by CLI, no signup | `pnpm seed:owner` → `src/server/auth/owner.ts` (one owner; `--replace` rotates password, TOTP, codes, kills sessions) |
| argon2id | `src/server/auth/password.ts`: m=64 MiB, t=3 (above OWASP's 19 MiB/t=2); 12+ chars |
| TOTP RFC 6238, ±1 step | `src/server/auth/totp.ts` (verified against RFC 6238/4226 vectors); replay: `users.totp_last_step`, consumed atomically |
| Recovery codes, hashed, one-time | `src/server/auth/recovery.ts` (10 × 60-bit, SHA-256) |
| TOTP secret at rest | AES-256-GCM, key = HKDF(SESSION_SECRET, "totp-secret"); SESSION_SECRET therefore required in every mode and must stay stable |
| Login rate limit + lockout | `src/server/auth/login.ts`: per IP, 5 failures/min, doubling lockout capped 24 h, reset by a successful login. **No global lockout** (one owner must not be lockable by anyone) |
| Sessions | 256-bit id, stored sha256, `__Host-` cookie HttpOnly+Secure+SameSite=Strict, 12 h idle (sliding), 7 d absolute |
| Re-auth for sensitive changes | TOTP within 5 min: kill switch OFF, live ON (caps: Phase 06 settings) |
| CSRF | SameSite=Strict + exact Origin match on every non-GET, missing Origin / `Sec-Fetch-Site: cross-site` refused (`src/server/http/guard.ts`) |
| Kill switch | env OR DB; blocks all but close-now (`src/server/killSwitch.ts`); ON never needs re-auth |
| Live opt-in twice + account check | `src/server/tradingMode.ts`: live needs TRADING_MODE=live + `accounts.live_enabled` + broker says REAL; demo refuses a REAL account |
| Audit append-only | trigger refuses UPDATE/DELETE/TRUNCATE for everyone (Supabase's service role bypasses RLS); hash chain + `verifyChain` detects edits/deletions |
| Public Supabase keys | RLS enabled on every table, no policies |
| CSP | `src/proxy.ts` + `src/server/http/csp.ts`: per-request nonce, `strict-dynamic`, no unsafe-* in production; COOP/CORP same-origin; HSTS |
| Secrets in logs | path redaction + value scrubbing of env secrets (`src/server/logger.ts`); generic 500s, details only in the log |
| Client IP | right-most X-Forwarded-For entry (the one our host's proxy adds) |
