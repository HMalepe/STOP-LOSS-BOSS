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
