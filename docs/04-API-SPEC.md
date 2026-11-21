# 04: API Spec

All routes: JSON, Zod-validated, session cookie required (except auth), CSRF-safe (SameSite=strict + origin check).
Errors: `{ error: { code: string, message: string, details?: unknown } }`.

| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/login | {password} → step 1; returns `needsTotp` |
| POST | /api/auth/totp | {code} → session cookie |
| POST | /api/auth/logout | end session |
| GET | /api/state | account, mode, positions summary per symbol, orders count, quote, spec, killSwitch |
| GET | /api/positions?symbol=&side= | full list (paged at 500) |
| POST | /api/plans | create a dry-run plan (body below) → PlanSummary |
| GET | /api/plans/:id | plan summary + items |
| POST | /api/plans/:id/execute | execute → { executionId } (202) |
| GET | /api/executions/:id | status, progress, counts |
| GET | /api/executions/:id/stream | SSE progress events |
| POST | /api/executions/:id/retry-failed | creates a new plan from failed items → PlanSummary |
| POST | /api/close-now | {filter, cancelPending, confirm:"CLOSE"} → executes immediately (plan built and run in one call, still audited) |
| GET | /api/history?cursor= | past executions |
| POST | /api/admin/kill-switch | {halted:boolean} |

## POST /api/plans body (discriminated union on `action`)
```ts
{ action: "levels",    filter, stopLoss?: number, takeProfit?: number }
{ action: "closeAt",   filter, price: number }
{ action: "breakeven", filter, offsetPoints: number }
{ action: "lock",      filter, distancePoints: number }
{ action: "market",    symbol, side: "BUY"|"SELL", count: number, volume: number, slPoints?: number, tpPoints?: number }
{ action: "ladder",    symbol, type: "BUY_LIMIT"|"BUY_STOP"|"SELL_LIMIT"|"SELL_STOP", from: number, to: number,
                       levels?: number, stepPoints?: number, volume: number, slPoints?: number, tpPoints?: number }
{ action: "cancel",    filter: OrderFilter }
filter = { symbol: string, side: "ALL"|"BUY"|"SELL", magic?: number, inProfitOnly?: boolean }
```

## PlanSummary
```ts
{ id, action, expiresAt, quote:{bid,ask,time}, count, skipped:[{id,reason}],
  breakdown:{ buys, sells, asSL?, asTP?, totalLots?, prices?: number[] }, warnings: string[], mode: "mock"|"demo"|"live" }
```
Invalid plan → 422 with `code: "PLAN_INVALID"` and `details: [{side, rule, boundary, message}]`.

## Error codes
`UNAUTHENTICATED`, `TOTP_REQUIRED`, `RATE_LIMITED`, `VALIDATION`, `PLAN_INVALID`, `PLAN_EXPIRED`, `PLAN_ALREADY_EXECUTED`,
`PRICE_MOVED`, `TRADING_HALTED`, `LIVE_NOT_ENABLED`, `BROKER_UNAVAILABLE`, `INTERNAL`.

## SSE events
`progress {done,total,ok,failed}` · `item {targetId,ok,code,message,attempts,latencyMs}` · `complete {summary}` · `error {code,message}`
