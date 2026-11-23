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
| Owner seeded by CLI, no signup | `pnpm seed:owner` → `src/server/auth/owner.ts` (one owner; `--replace` rotates IN PLACE: same id, new password/TOTP/codes, replay counter reset, every session revoked, pending logins dropped; one transaction with its audit row) |
| argon2id | `src/server/auth/password.ts`: m=64 MiB, t=3 (above OWASP's 19 MiB/t=2); 12+ chars |
| TOTP RFC 6238, ±1 step | `src/server/auth/totp.ts` (verified against RFC 6238/4226 vectors); replay: `users.totp_last_step`, consumed atomically |
| Recovery codes, hashed, one-time | `src/server/auth/recovery.ts` (10 × 60-bit, SHA-256) |
| TOTP secret at rest | AES-256-GCM, key = HKDF(SESSION_SECRET, "totp-secret"), AAD = user id (a ciphertext copied to another row won't decrypt). SESSION_SECRET is the app's data key: required in every mode, must stay stable, and rotating it means re-running `seed:owner --replace` |
| Login rate limit + lockout | `src/server/auth/login.ts`, **reserve-then-verify**: each attempt is recorded as a failure under an advisory lock BEFORE any secret is checked, so parallel requests can't outrun the count. Per client network (IPv4 address / IPv6 /64): 5 failures/min, doubling lockout capped 24 h, reset by a successful login. Per account, second factor only: 10 failures/hour whatever the IP. Pending logins: 5 attempts, spent atomically. **No account-wide lockout on the password** (one owner must not be lockable by anyone) |
| Sessions | 256-bit id, stored sha256, `__Host-` cookie HttpOnly+Secure+SameSite=Strict, 12 h idle (sliding), 7 d absolute |
| Re-auth for sensitive changes | TOTP within 5 min: kill switch OFF, live ON, sign out everywhere (caps: Phase 06 settings). 3 wrong re-auth codes in a row revoke the session |
| Incident response | `POST /api/auth/sessions/revoke-all` (re-auth, audited, clears the cookie); `pnpm seed:owner --replace` for lost credentials |
| Login flood (memory) | `src/server/auth/hashGate.ts`: 2 argon2 verifies at once, 6 queued, then 429 Busy (64 MiB each) |
| CSRF | SameSite=Strict + exact Origin match on every non-GET, missing Origin / `Sec-Fetch-Site: cross-site` refused (`src/server/http/guard.ts`). APP_ORIGIN is normalised to a bare origin. Mock with no APP_ORIGIN: same-origin on loopback only (DNS rebinding) |
| Kill switch | env OR DB; blocks all but close-now (`src/server/killSwitch.ts`); ON never needs re-auth; flag + audit row in one transaction. Enforced on trading routes from Phase 06 (`tradingGate`, `tradingModeGate` exist and are tested) |
| Live opt-in twice + account check | `src/server/tradingMode.ts`: live needs TRADING_MODE=live + `accounts.live_enabled` + broker says REAL; demo refuses a REAL account |
| Audit append-only | trigger refuses UPDATE/DELETE/TRUNCATE for everyone (Supabase's service role bypasses RLS); **HMAC** chain, key = HKDF(SESSION_SECRET, "audit-chain"), which lives on the app host, not in the DB: a DB owner who disables the trigger still can't re-chain a forged history. `audit()` joins the caller's transaction (change + record are atomic). Details are hashed as jsonb stores them |
| Public Supabase keys | RLS enabled on every table, no policies; `0002` also revokes every table/sequence grant from `anon` and `authenticated` (RLS doesn't cover TRUNCATE) |
| Least privilege | role `order_desk_app` (0002): DML on app tables, only SELECT+INSERT on `audit_log`, no DDL, can't disable triggers. Deploy: see 08 |
| CSP | `src/proxy.ts` + `src/server/http/csp.ts`: per-request nonce, `strict-dynamic`, no unsafe-* in production; COOP/CORP same-origin; HSTS |
| Secrets in logs | path redaction + value scrubbing of env secrets (`src/server/logger.ts`); generic 500s, details only in the log |
| Client IP | ONLY the header named by `TRUSTED_IP_HEADER` (required in demo/live); for X-Forwarded-For, its right-most entry. Missing → one shared "unknown" bucket (fails closed) |

## Security review (Phase 05): findings and fixes
The security-engineer review attacked the as-built auth. Every finding has a regression test that reproduces the attack
(`tests/integration/security-review.test.ts`).

| Sev | Finding | Fix |
|---|---|---|
| HIGH | Limits were checked, then the secret verified, then the failure recorded: 50 parallel guesses all passed the check | Reserve-then-verify under `pg_advisory_xact_lock`; pending attempts spent with one `UPDATE … WHERE attempts < 5 RETURNING`. Test: 50 parallel → ≤ 5 checked |
| HIGH | Throttling was per IP only: 40 IPs × 5 = 200 second-factor guesses/min with the password | Per-account second-factor budget (10/h); IPv6 keyed by /64; client IP only from the configured trusted header. Test: the 11th failure is refused from any IP |
| HIGH | `seed:owner --replace` died on foreign keys once the kill switch had been used; no way to sign out everywhere | Rotate in place; `config.updated_by` → `on delete set null`; revoke-all route. Test: replace after kill-switch use revokes old sessions |
| MED | Audit rows written after the change, outside its transaction | Nested `tx` joins the outer one; kill switch, live flag, login, logout, revoke-all are atomic with their records |
| MED | Unbounded argon2 (64 MiB each) under a login flood | HashGate |
| MED | Unkeyed chain: a DB owner could rewrite and re-chain | HMAC with an app-held key |
| MED | Supabase API roles kept table grants; app ran as owner | 0002 revokes; `order_desk_app` role |
| MED | Vulnerable transitive deps (axios, lodash, crypto-js via the MetaApi SDK) | `pnpm.overrides`; `pnpm audit --prod`: 70 → 3 (1 low, 2 moderate, no fix upstream) |
| LOW | Trailing-slash APP_ORIGIN, mock DNS rebinding, Dates in audit details, TOTP ciphertext not bound to its row | Normalised origin, loopback-only fallback, details hashed as stored, AES-GCM AAD |

Residual risk, accepted: an attacker WITH the password can spend the owner's second-factor budget and block their login
for up to an hour (sessions last 7 days, so the owner is normally already signed in; rotate the password with
`seed:owner --replace`). A distributed password-guessing botnet is throttled per network and by HashGate, not per account,
on purpose.
