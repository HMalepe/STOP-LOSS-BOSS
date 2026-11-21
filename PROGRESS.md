# PROGRESS

> The single source of truth for where the build is. Claude updates this at every checkpoint. Keep it short and current.

## Now
- Phase: 00 (kickoff) 🟨, review done, waiting on owner answers Q1 to Q5
- Current milestone: M3 (questions) asked
- Blockers: none for Phase 01 (Q1 to Q5 affect Phase 2 onward, not the skeleton)

## Phases
| # | Phase | Status | Notes |
|---|---|---|---|
| 00 | Kickoff and board review | 🟨 | Spec reviewed, MetaApi facts verified, ADR-0004 to 0007 written. Awaiting Q1 to Q5 |
| 01 | Foundation | ⬜ | Can start now |
| 02 | Domain core | ⬜ | Rules R0.1, R0.2, R3.6, R4.5, R4.6, R6.5, R8.3, §9 added |
| 03 | Broker adapter | ⬜ | Must test the [T] items in 03-TRADING-RULES on demo |
| 04 | Execution engine | ⬜ | Limiter is credit-based (09) |
| 05 | Auth and security | ⬜ | |
| 06 | API routes | ⬜ | |
| 07 | UI | ⬜ | |
| 08 | Order Desk (bulk orders, presets, ladders) | ⬜ | |
| 09 | Realtime and performance | ⬜ | May move earlier (ADR-0007) |
| 10 | Hardening and go-live | ⬜ | |

Legend: ⬜ not started · 🟨 in progress · ✅ done · ⛔ blocked

## Decisions log (one line each; link the ADR)
- 2026-11-21: Close-at defaults to raw X and states bid/ask timing in the preview ([ADR-0004](docs/adr/0004-close-at-bid-ask-asymmetry.md))
- 2026-11-21: Batches identified by magic number, comment is a label only ([ADR-0005](docs/adr/0005-batch-identity-magic.md))
- 2026-11-21: Reads come from streamed state during batches, to keep credits for trades ([ADR-0007](docs/adr/0007-streaming-reads-single-service.md))
- 2026-11-21: R5.3 rewritten: entry stops validated against the closing side (buy → bid, sell → ask)
- 2026-11-21: Entry timeouts reconcile before retry, never blind-retry (R6.5)
- 2026-11-21: Spec-load failure refuses the plan, no d = 0 fallback (R0.1)

## Open questions for the owner
- **Q1** Close-at mode: raw X only (rec.), or also a `spreadAligned` toggle? (ADR-0004)
- **Q2** Account: is your Exness demo **hedging**, which symbol(s) do you scalp, and is it connected to MetaApi yet?
- **Q3** Ship in slices: v1 core on demo first, Order Desk second, live last? (rec. yes, ADR-0006)
- **Q4** Caps defaults: 100 orders/action, 5 lots/action, 2% equity risk/action, spread guard off? (rec. yes)
- **Q5** Hosting: one always-on service on Railway/Fly (rec.) or Vercel + separate worker later? (ADR-0007)

## Unverified facts (must be tested on Exness demo via MetaApi, Phase 3)
- POSITION_MODIFY behaviour when one level is omitted (docs silent)
- MetaApi accepts and returns `magic` on market/pending orders and positions
- Field name for account margin mode (hedging vs netting)
- Field names for tick value / tick size; whether MetaApi exposes broker margin calc
- Real trade latency (streaming vs REST), max in-flight trades, Exness stops/freeze levels, max open positions
- Whether MetaApi deduplicates on `clientId` (would make R6.5 simpler)
