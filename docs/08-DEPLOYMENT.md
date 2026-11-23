# 08: Deployment

## Services
- **Railway or Fly (ADR-0007):** one always-on Node service running Next.js plus the executor, holding the MetaApi streaming connection. Region chosen by measured round-trip to the MetaApi region in Phase 3.
- **Vercel:** optional, not used by default.
- **Supabase:** Postgres + Realtime. Migrations in `supabase/migrations`.
- **MetaApi:** add the Exness MT5 account (start with an Exness DEMO account). Pick the MetaApi region closest to the broker server (verify in MetaApi docs/dashboard).

## Env vars (validated in src/server/env.ts)
```
TRADING_MODE=mock|demo|live
TRADING_HALTED=0
METAAPI_TOKEN=
METAAPI_ACCOUNT_ID=
METAAPI_REGION=
DATABASE_URL= / SUPABASE_URL= / SUPABASE_SERVICE_ROLE_KEY=
SESSION_SECRET=           # 32+ random bytes
APP_ORIGIN=https://your-app.vercel.app
TRUSTED_IP_HEADER=x-forwarded-for   # the ONE header your host's proxy sets: x-forwarded-for | x-real-ip | cf-connecting-ip | fly-client-ip | true-client-ip
MAX_ORDERS_PER_ACTION=100
MAX_TOTAL_LOTS=5
MAX_RISK_PCT_PER_ACTION=2   # % of equity at risk to SL, per action (R9.2)
SPREAD_GUARD_K=3            # adaptive spread guard multiplier (R9.4b)
SPREAD_WINDOW_SEC=300
WORKER_URL= / WORKER_SHARED_SECRET=   # Phase 9
```

## Database roles (least privilege)
Migrations run as the database owner. The app itself runs as `order_desk_app` (created by `0002_security_hardening.sql`,
NOLOGIN until you enable it): it can read and write the app's tables, only read and append the audit log, and can't
alter tables or disable triggers.
```sql
alter role order_desk_app with login password '<generate one>';
```
Then point the app's `DATABASE_URL` at that role, and keep the owner's URL only where migrations and `seed:owner` run.
`SESSION_SECRET` must not live in the database host: it keys the audit chain, so whoever holds only the database can't
forge history.

## Go-live checklist
- [ ] All tests green; load test passes at 1,000 positions.
- [ ] 2 weeks on Exness demo through the real MetaApi with daily use, zero unexplained failures in the audit log.
- [ ] Measured real latency and rate limits recorded in 09-PERFORMANCE.
- [ ] Kill switch tested in production.
- [ ] TOTP enabled, recovery codes stored offline.
- [ ] Caps set conservatively.
- [ ] `live_enabled` flipped manually in DB with re-auth. First live use: small size.
