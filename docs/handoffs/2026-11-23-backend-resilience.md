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

## Added later this session
- dbe8551 observability (call logs, counters, log alerts, /api/admin/metrics) + /api/health, /api/health/ready
- 9078687 Phase 08 M1: `src/domain/entries.ts` buildMarketBatch (OD1), 100% branches
- 4ee6165 Phase 08 M2: `buildLadder` (OD2) in the same file; new rule R5.6a in docs/03
- 79efc1a M3a entries preview→execute (batch_seq migration 0004, R0.2, §7 re-check, no entry retries)
- ccf92bc M3b risk to SL + margin (`src/domain/risk.ts`, `BrokerProvider.calculateMargin`, summary.risk)
- 8bbb627 M3c spread guard (`src/domain/spread.ts`, `SpreadMonitor`, 409 SPREAD_TOO_WIDE)
- (this) restart reconcile of entries by clientId (`reconcileRestartedEntries`, run at boot)
- Merge note: UI moved the DB singleton to globalThis; `startedDb()` now returns `shared.db`.

## Added 2026-11-25
- 8e17b35 fix: batches could share a clientId (seq 10 item 10 = seq 361 item 0); reconcile now needs magic AND clientId
- b536014 R5.1 grid rule, R5.5b, R9.2 rounding/commission/noStop (explicit opt-in, keeps the owner's "allow")
- b896858 R5.3b stop verified after fill, else set, else close the position
- 5a4e1d0 R9.10 systemic failures stop a batch; R9.7 free margin re-read at execute (409 MARGIN_INSUFFICIENT)
- (this) M4 presets: `src/server/presets.ts`, `presetRoutes.ts`, `previewPlan.ts` (shared preview path)

## Next session should start by
1. Remaining §9 gaps are listed in PROGRESS.md ("Order Desk: code vs reviewed §9"): R9.3 margin method, R9.4b slack/floor,
   R9.11 fill modes + drift breaker, R9.12 pending expiry. UI for batches, ladders and presets (api: /api/presets, plans
   with action market/ladder + noStop).
2. M4: presets CRUD. UI can use `/api/settings/caps`, `/api/admin/metrics`.

## State check
- `pnpm verify`: green (1017 passed, 1 skipped). Load: 0 duplicates.
- Uncommitted changes: none after this note.
