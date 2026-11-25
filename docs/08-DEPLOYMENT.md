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
MAX_POSITIONS_PER_BATCH=1000   # most positions one modify/close-at may touch (close-now exempt)
MAX_TOTAL_LOTS=5
MAX_RISK_PCT_PER_ACTION=2   # % of equity at risk to SL, per action (R9.2)
SPREAD_GUARD_K=3            # adaptive spread guard multiplier (R9.4b)
SPREAD_WINDOW_SEC=300
COMMISSION_PER_LOT=0         # R9.2: account-currency commission per lot, added to risk (raw/zero accounts)
SPREAD_MAX_POINTS=           # optional R9.4a absolute max per symbol, e.g. EURUSD:30,XAUUSD:80 (off by default)
WORKER_URL= / WORKER_SHARED_SECRET=   # Phase 9
NEXT_MANUAL_SIG_HANDLE=true # required outside mock: lets our shutdown drain run (see Graceful shutdown)
SHUTDOWN_DRAIN_MS=15000     # how long running batches get to finish on SIGTERM
```

## Health checks and alerts
- **Liveness** `GET /api/health`: 200 while the process answers. Point the host's restart check here.
- **Readiness** `GET /api/health/ready`: 200 only if the database answers, the broker is connected AND synchronized,
  and the app isn't shutting down; otherwise 503 with `{ready, checks: {db, broker, accepting}}` (booleans only).
  Point the host's traffic/deploy check here. A cold process kicks its broker start from this probe (at most once per 5 s).
- **Alerts** are log lines at level `error` with an `alert` field (`src/server/observability.ts`). Create a log alert
  on `alert` existing; each one means a human should look:
  `unknown_outcome` (check MT5 now) · `breaker_open` · `failure_rate` · `execution_slow` · `interrupted`.
- **Metrics** `GET /api/admin/metrics` (owner session): counters since process start and the breaker state.
- Every broker call is an `info` line with executionId, op, target, attempt, code and latency.

## Graceful shutdown (deploys and restarts)
On SIGTERM the app stops accepting executes (503 `SHUTTING_DOWN`, `Retry-After: 5`, nothing claimed), tells normal
batches to stop picking up new items, lets close-now keep going, waits up to `SHUTDOWN_DRAIN_MS` for running batches and
their result writes, then aborts the rest, marks them interrupted (never-sent items "not sent", mid-send items unknown),
closes the broker and the database, and exits. A second signal exits at once; boot recovery cleans up on the next start.

Two settings make this real. Both defaults kill the process before the drain can finish:
- **Next.js** exits on SIGTERM immediately (`process.exit(143)`) unless `NEXT_MANUAL_SIG_HANDLE` is set. Verified in
  `next/dist/server/lib/start-server.js`. `pnpm start` sets it; the env check refuses demo/live without it.
- **The host's kill timeout** must exceed `SHUTDOWN_DRAIN_MS` + ~15 s (grace, bounded closes, backstop):
  - Fly: `kill_timeout = 35` as a **top-level** key in `fly.toml` (default 5 s, max 300 s;
    [docs](https://fly.io/docs/reference/configuration/)). Under `[http_service]` it is ignored.
  - Railway: service variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35` (default 0 s, i.e. SIGKILL straight after
    SIGTERM; [docs](https://docs.railway.com/deployments/deployment-teardown)).

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
