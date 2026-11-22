# PROGRESS

> The single source of truth for where the build is. Claude updates this at every checkpoint. Keep it short and current.

## Now
- Phase: 04 (execution engine) ⬜, next up
- Current milestone: none
- Blockers: **Q2** (Exness demo connected to MetaApi) for the live [T] tests in Phase 03. MockBroker and adapter code can start without it

## Phases
| # | Phase | Status | Notes |
|---|---|---|---|
| 00 | Kickoff and board review | ✅ | Spec reviewed, MetaApi facts verified, ADR-0004 to 0007. Owner delegated Q1, Q3 to Q5 to Claude |
| 01 | Foundation | ✅ | 81 tests, clean clone passes `pnpm verify`, E2E on 390×844, CI workflow |
| 02 | Domain core | ✅ | 294 tests, domain 100% lines / 99% branches, fuzzed. Safety review: 1 critical + 1 high found and fixed |
| 03 | Broker adapter | ✅ | 460 tests. SDK contract verified from the package. Board review (architect, trading systems, SRE): 1 critical, 8 high/must-fix fixed. Live demo contract run pending Q2 |
| 04 | Execution engine | ⬜ | Limiter is credit-based (09). Carry-overs below |
| 05 | Auth and security | ⬜ | |
| 06 | API routes | ⬜ | |
| 07 | UI | ⬜ | |
| 08 | Order Desk (bulk orders, presets, ladders) | ⬜ | |
| 09 | Realtime and performance | ⬜ | Streaming connection lands in Phase 03 instead (ADR-0007) |
| 10 | Hardening and go-live | ⬜ | |

Legend: ⬜ not started · 🟨 in progress · ✅ done · ⛔ blocked

## Decisions log (one line each; link the ADR)
- 2026-11-21: Close-at defaults to raw X and states bid/ask timing in the preview ([ADR-0004](docs/adr/0004-close-at-bid-ask-asymmetry.md))
- 2026-11-21: Batches identified by magic number, comment is a label only ([ADR-0005](docs/adr/0005-batch-identity-magic.md))
- 2026-11-21: Reads come from streamed state during batches, to keep credits for trades ([ADR-0007](docs/adr/0007-streaming-reads-single-service.md))
- 2026-11-21: R5.3 rewritten: entry stops validated against the closing side (buy → bid, sell → ask)
- 2026-11-21: Entry timeouts reconcile before retry, never blind-retry (R6.5)
- 2026-11-21: Spec-load failure refuses the plan, no d = 0 fallback (R0.1)
- 2026-11-21 (owner delegated): Q1 raw X in v1, spreadAligned opt-in v1.1 (ADR-0004)
- 2026-11-21 (owner delegated): Q3 release slices accepted (ADR-0006)
- 2026-11-21 (owner delegated): Q4 caps 100 orders / 5 lots / 2% risk per action; adaptive spread guard ON (3× rolling median, R9.4b)
- 2026-11-21 (owner delegated): Q5 one always-on Node service on Railway/Fly holding the stream (ADR-0007)
- 2026-11-21: TypeScript pinned to 6.0.x: typescript-eslint 8.73 supports < 6.1, so TS 7 waits
- 2026-11-21: Stack versions: Next 16.4, React 19.3, ESLint 10, Vitest 5, Zod 4.6, Pino 10, Tailwind 4.3, Playwright 1.63 (matches the preinstalled browser)
- 2026-11-21: Architecture boundaries are lint rules with their own tests (eslint/boundaries.ts)
- 2026-11-21: Logger scrubs actual secret values, not just secret key names
- 2026-11-21: Bad env exits the process with code 1 at boot (Next would otherwise serve 500s forever)
- 2026-11-21: All rule maths in integer points; lint rule bans comparing Price values outside price.ts
- 2026-11-21: Freeze level checked on existing AND new levels (MQL5 docs ambiguous): R2.9 frozen = skip, not error
- 2026-11-21: Close-now never blocked by spec/quote/bad data/duplicates (R4.7, R0.3, R0.5): it closes by ticket
- 2026-11-21: Levels ≤ 0 points are plan errors (R0.4): 0 is "remove" on the MT5 wire
- 2026-11-21: Helper rounding never gives less than asked (R8.4); lock never locks a loss (R8.6)
- 2026-11-22: Broker wire policy: always send both levels, 0 = none; own timeouts; SDK never retries trades ([ADR-0008](docs/adr/0008-broker-wire-policy.md))
- 2026-11-22: Entry reconciliation protocol: wait on `settled`, reconcile by clientId incl. in-flight, else "check manually", never blind retry ([ADR-0009](docs/adr/0009-entry-reconciliation.md))
- 2026-11-22: Close-now never gives up early: book check after any failed close; transient refusals retryable for close (R6.6)
- 2026-11-22: Position profit = open part net of swap + commission, rounded to cents (my earlier reading of the SDK was wrong; fixed)
- 2026-11-22: R7.1 drift guard re-reads untouched levels; R7.2 quote age limit
- 2026-11-22: MetaApi connection: per-attempt timeout, overall deadline, jittered backoff, fail-fast on auth errors, watchdog reconnect
- 2026-11-21: Deferred: R1.1 batch filter → Phase 08 with R9.1; stale-quote check → drift guard §7 (Phase 04/06)

## Phase 04 carry-overs (from the Phase 03 board review)
- Executor waits on `settled` and follows ADR-0009 for every ambiguous entry; property tests for "never a double entry"
- MockBroker: delayed landing of a lost-reply entry (fills N s later) to test the zombie path end to end
- R7.1 untouched-level re-read and R7.2 quote age in the drift guard; `getSnapshot(symbol)` read in one tick
- R6.7 partial entry fills: re-read volume
- Structured log line per broker call (op, planId, item, clientId, code, class, latency); SDK logger at info+
- `createBroker()` factory that fails closed: account `tradeMode` must match TRADING_MODE (demo app never drives a REAL account)
- Market-data subscriptions: unsubscribe unused symbols; check credit cost
- Later (Phase 06/09): lenient close-now parse, health routes, graceful shutdown, metrics/alerts, history lookup by clientId

## Open questions for the owner
- **Q2** (needed by Phase 03) Is your Exness demo **hedging**, which symbol(s) do you scalp, and is it connected to MetaApi yet? R0.2 detects netting at runtime anyway.

## Unverified facts (must be tested on Exness demo via MetaApi, Phase 3)
- ~~POSITION_MODIFY behaviour when one level is omitted~~ no longer matters: we always send both levels (ADR-0008)
- MetaApi accepts and returns `magic` and `clientId` on orders/positions: **types say yes**; the contract suite checks both on demo
- Sending 0 for a level removes it on MetaApi (ADR-0008 rests on it): contract suite checks it on demo
- Real codes for close-twice and cancel-twice (mock assumes 10036 / 10035): contract suite records them
- ~~Field name for account margin mode~~ `accountInformation.marginMode` (verified in SDK types)
- ~~Tick value / margin calc field names~~ `price.profitTickValue/lossTickValue`, `position.currentTickValue`, `calculateMargin()` (verified)
- Real trade latency (streaming vs REST), max in-flight trades, Exness stops/freeze levels, max open positions
- Whether MetaApi deduplicates on `clientId` (would make R6.5 simpler)
- Does MT5 re-check the preserved (unchanged) level against stopsLevel on TRADE_ACTION_SLTP? (R2.11: warn now, skip if yes)
- Freeze level: existing levels, new levels, or both? (R2.9 assumes both)
