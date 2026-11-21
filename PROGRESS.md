# PROGRESS

> The single source of truth for where the build is. Claude updates this at every checkpoint. Keep it short and current.

## Now
- Phase: 01 (foundation) 🟨
- Current milestone: M1 project skeleton
- Blockers: none. Q2 (account facts) needed before Phase 03

## Phases
| # | Phase | Status | Notes |
|---|---|---|---|
| 00 | Kickoff and board review | ✅ | Spec reviewed, MetaApi facts verified, ADR-0004 to 0007. Owner delegated Q1, Q3 to Q5 to Claude |
| 01 | Foundation | 🟨 | |
| 02 | Domain core | ⬜ | Rules R0.1, R0.2, R3.6, R4.5, R4.6, R6.5, R8.3, §9 added |
| 03 | Broker adapter | ⬜ | Must test the [T] items in 03-TRADING-RULES on demo |
| 04 | Execution engine | ⬜ | Limiter is credit-based (09) |
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

## Open questions for the owner
- **Q2** (needed by Phase 03) Is your Exness demo **hedging**, which symbol(s) do you scalp, and is it connected to MetaApi yet? R0.2 detects netting at runtime anyway.

## Unverified facts (must be tested on Exness demo via MetaApi, Phase 3)
- POSITION_MODIFY behaviour when one level is omitted (docs silent)
- MetaApi accepts and returns `magic` on market/pending orders and positions
- Field name for account margin mode (hedging vs netting)
- Field names for tick value / tick size; whether MetaApi exposes broker margin calc
- Real trade latency (streaming vs REST), max in-flight trades, Exness stops/freeze levels, max open positions
- Whether MetaApi deduplicates on `clientId` (would make R6.5 simpler)
