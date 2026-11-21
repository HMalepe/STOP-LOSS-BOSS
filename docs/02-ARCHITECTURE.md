# 02: Architecture

```
Phone (PWA) ──HTTPS──▶ Next.js on Vercel ──▶ MetaApi cloud ──▶ MT5 server (Exness)
                          │                      ▲
                          ├── Supabase (users, sessions, plans, audit, jobs)
                          └── long-running worker (see ADR-0003) ──┘ streaming connection
```

## Why a worker
Serverless functions are cold, short-lived and time-limited. Placing 1,000 actions takes longer than a request should block,
and a warm streaming MetaApi connection is much faster per call than REST from a cold start.
**Decision (ADR-0003):** execution runs in a small always-on Node worker (Railway or Fly) holding a persistent MetaApi
streaming connection. Next.js creates a job, the worker executes it, and progress streams back (Supabase Realtime or SSE).
Phase 1 to 6 may run executor in-process behind the same `JobRunner` interface, so swapping is a config change.

## Folder layout
```
src/
  domain/            pure: types, price.ts, rules.ts (validate, closeAt, breakeven), plan.ts (build plans), ladder.ts
  broker/            BrokerProvider.ts (interface), MockBroker.ts, MetaApiBroker.ts, schemas.ts (Zod for broker data), retcodes.ts
  execution/         executor.ts (concurrency + retry + rate limit), rateLimiter.ts (token bucket), idempotency.ts, events.ts
  server/
    auth/            password (argon2id), totp, session (httpOnly cookie), middleware
    audit/           append-only writer
    plans/           create plan (dry-run) → store with TTL → execute by planId
    killswitch.ts
    env.ts           Zod-validated env, fails fast at boot
  app/               Next.js routes: (auth)/login, dashboard, history, settings; api/* route handlers
  ui/                components (Button, Stat, ConfirmSheet, ResultTable, PriceInput, ArmButton)
worker/              entry for the long-running executor (Phase 9)
tests/               unit (mirrors src), integration, e2e (Playwright), load
supabase/migrations/ SQL migrations
```

## Core interfaces (sketch, refine in Phase 3)
```ts
interface BrokerProvider {
  getAccount(): Promise<Account>;
  getPositions(filter?: PositionFilter): Promise<Position[]>;
  getOrders(filter?: OrderFilter): Promise<PendingOrder[]>;
  getQuote(symbol: string): Promise<Quote>;              // bid, ask, time
  getSymbolSpec(symbol: string): Promise<SymbolSpec>;    // digits, point, stopsLevel, freezeLevel, volumeMin/Step/Max
  modifyPosition(id: string, levels: { sl?: number; tp?: number }): Promise<TradeResult>;
  closePosition(id: string): Promise<TradeResult>;
  placeMarket(o: MarketOrderReq): Promise<TradeResult>;
  placePending(o: PendingOrderReq): Promise<TradeResult>;
  cancelOrder(id: string): Promise<TradeResult>;
}
type TradeResult = { ok: boolean; code: number | string; message: string; latencyMs: number; retryable: boolean };
```

## Data flow for any action
1. UI → `POST /api/plans` {action, filter, params}. Server loads fresh positions + quote + spec, builds a **Plan** with the pure domain, stores it (TTL 30s, hash of inputs), and returns the summary.
2. UI shows the preview → user confirms → `POST /api/plans/:id/execute`.
3. Server re-checks: plan not expired, not executed, kill switch, quote drift (if price moved past a threshold so the plan is now invalid, re-validate and reject with "price moved, re-preview").
4. Executor runs the plan with bounded concurrency, retries retryable codes with jittered backoff, and emits progress.
5. Audit row per action plus per item. UI shows the live progress bar, then the result table.

## Data model (Supabase)
`users`, `sessions`, `accounts` (metaapi_account_id, mode, live_enabled), `plans` (id, user, action, params jsonb, items jsonb, input_hash, expires_at, status),
`executions` (plan_id unique, started/finished, counts), `execution_items` (plan_id, target_id, op, ok, code, message, latency_ms, attempts),
`audit_log` (append-only; RLS denies update/delete).

## Order Desk additions
- `src/domain/orderDesk.ts`: bulk market plans, risk calc, caps, spread guard (pure).
- `src/domain/ladder.ts`: extended with scaled lots.
- `src/server/presets/`: preset CRUD + fire (always builds a fresh plan).
- Tables: `presets` (id, user, name, recipe jsonb, pinned, sort), and `plans.group_tag`.
