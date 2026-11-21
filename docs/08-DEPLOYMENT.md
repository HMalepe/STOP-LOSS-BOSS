# 08: Deployment

## Services
- **Vercel:** Next.js app.
- **Supabase:** Postgres + Realtime. Migrations in `supabase/migrations`.
- **Railway or Fly:** worker (Phase 9). Region close to the MetaApi region in use.
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
MAX_ORDERS_PER_ACTION=100
MAX_TOTAL_LOTS=5
WORKER_URL= / WORKER_SHARED_SECRET=   # Phase 9
```

## Go-live checklist
- [ ] All tests green; load test passes at 1,000 positions.
- [ ] 2 weeks on Exness demo through the real MetaApi with daily use, zero unexplained failures in the audit log.
- [ ] Measured real latency and rate limits recorded in 09-PERFORMANCE.
- [ ] Kill switch tested in production.
- [ ] TOTP enabled, recovery codes stored offline.
- [ ] Caps set conservatively.
- [ ] `live_enabled` flipped manually in DB with re-auth. First live use: small size.
