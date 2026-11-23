# Handoff: 2026-11-23, backend resilience carry-overs (parallel to Phase 07 UI)

## Where we are
Branch `claude/dashboard-account-trading-lk0mah`. Every Phase 03–06 resilience carry-over except observability is done.
The UI branch (`claude/determined-mccarthy-kgq7ml`) is merged in up to f2132c6; merging this branch back is conflict-free.

## Done this session
- 54a8322 restart recovery: items `pending` at claim, `sending` before first send; boot → "not sent" (retryable) / unknown
- e15d6c5 close-now reads leniently (`getPositionsForClose`); one bad row no longer 503s the panic button
- 64e2074 graceful shutdown (SIGTERM drain 15 s, `SHUTTING_DOWN` 503 before claim, close-now keeps going)
- ea45be7 circuit breaker (5 consecutive connection failures → unsent items fail fast; health probe after 5 s)
- 6b95195 caps in DB: `GET/POST /api/settings/caps`, re-auth, env MAX_* are hard ceilings

## Gotchas
- `BrokerProvider` has `getPositionsForClose` / `getOrdersForClose`. Hand-written broker stubs need both.
- `TradingServices` lost `maxPerBatch`; it has `capCeilings: Caps` and `background: TaskTracker` instead.
- `JobRunner.start` can return `{ ok: false, code: "SHUTTING_DOWN" }`. Never map it to PLAN_ALREADY_EXECUTED.
- Demo/live boot refuses without `NEXT_MANUAL_SIG_HANDLE=true` (Next.js exits on SIGTERM otherwise). `pnpm start` sets it.
- Deploy: host kill timeout must be > drain + 15 s. Fly default 5 s, Railway default 0 s (docs/08).
- After merging UI work, run `pnpm next typegen` if tsc complains about `Route` types (stale generated types).

## Next session should start by
1. UI: Settings page can now call `/api/settings/caps` (POST needs a fresh re-auth; show `ceilings`).
2. Remaining backend carry-overs: observability (typed event hook, metrics, alerts), health routes, history by clientId.
3. Entries (Phase 08): reconcile items left `sending` by clientId at boot (ADR-0009) instead of plain unknown.

## State check
- `pnpm verify`: green (885 passed, 1 skipped). Load: 0 duplicates.
- Uncommitted changes: none after this note.
