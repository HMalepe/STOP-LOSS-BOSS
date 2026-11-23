# ADR-0011: Cross-account pair (opposite legs, same size, no stops)
**Status:** accepted 2026-11-23 (owner). Not built. Lands after Phase 08 as Phase 08b. Needs the [T] checks below on two Exness demos first.

**Context.** The owner wants one action that opens a SELL on one MT5 account and a BUY of the same symbol and size on a second
account, both without stops. Today the whole stack is single-account (PRD: "design for multi-account later").

What the play is, written down so nobody mistakes it later:
- While both legs are open the net exposure is flat; the pair bleeds 2× spread + commission + swap.
- With no stops, the loser runs until broker stop-out. Loss per account is capped at that account's equity. The survivor is then a
  naked directional position. The expected value is negative (costs) unless the survivor is managed; payoff is option-like.
- The only structural edge is a gap through the loser's stop-out, where negative balance protection absorbs the deficit. Brokers
  commonly treat opposite positions across one owner's accounts as abuse and can void profits. **Owner precondition:** check Exness's
  client agreement (multi-account hedging, NBP) before live use. The app records the owner's acknowledgement once, per account pair, in audit.

## Decisions
1. **One pair plan, one `planId`.** Preview shows both legs together: account, side, symbol, lots, current bid/ask per account, spread cost,
   margin per account, and the risk line from (4). Execute runs exactly what was previewed (non-negotiable 1). Same `planId` twice = one
   set of broker calls (non-negotiable 7). Each leg gets its own `clientId` and the same batch `magic` (R9.1) on both accounts.
2. **Fire both legs concurrently**, never sequentially. Two independent broker connections, one request each, dispatched in the same tick.
   The result reports each fill price and the measured skew between fills (ms and points). "Simultaneous" is best-effort; the UI never claims otherwise.
3. **Leg failure: auto-close the filled leg. Not configurable.** A lone stopless leg is unbounded exposure, the worst state this play has.
   - Leg B rejected (definite refusal) → close leg A immediately via the close-now lane (urgent, R6.6 never-give-up rules).
   - Leg B timeout/unknown → reconcile B first (ADR-0009). Confirmed absent → close A. Confirmed filled → pair is OK.
     Still unknown at the reconcile deadline → do **not** close A blindly (that could leave B naked instead); raise a loud
     "pair state unknown, check both accounts" alert with a one-tap "close both legs" action.
   - Never report "done" unless both legs filled (non-negotiable 6).
4. **Risk rule for stopless pairs.** R9.2 (risk to SL) cannot apply. For a pair leg: risk = that account's equity at preview. The preview
   states it in money per account. The per-action risk cap (Q4: 2% of equity) does not apply to pair legs; instead the pair has its own
   cap `PAIR_MAX_LOTS` (configurable, re-auth to change, OD7). Margin check per account (R9.3), blocking.
5. **Survivor prompt.** When one leg closes and the other is still open (stop-out, manual close, anything), push a prompt for the survivor:
   add SL / add TP / lock profit (R8.x helpers) / close. The app never leaves a survivor silently naked.
6. **Hedging accounts on both legs (R0.2).** If either account is netting, entry is refused.
7. **Safety gates are per account.** Each leg needs its account's `live_enabled` (non-negotiable 2), its own mode check (demo refuses REAL),
   and its own audit rows linked by `planId`. Kill switch blocks pair entry; close-all-now closes every account.
8. **Connections.** ADR-0007's single stream becomes one stream per enabled account in the same service. Credits are per application,
   multiplied by deployed accounts (09-PERFORMANCE), so the budget scales; the limiter becomes per account.

## Must verify on demo before building [T]
- Two Exness accounts under one MetaApi token, possibly on different servers (MT5Real27 vs ?): connect time, credit accounting.
- Exness stop-out level on Standard accounts and what MetaApi streams when it happens (deal reason for stop-out; field name).
- Real fill skew between two concurrently dispatched market orders on different accounts (p50/p95), logged into 09-PERFORMANCE.
- Whether an Exness account can be netting at all on MT5 Standard (R0.2 read at connect regardless).

## Consequences
- `accounts` stops being a single-row table in practice: account picker in the UI, account id on every plan, position, and audit row.
- Execution gets a "pair" executor on top of the batch executor; its leg-failure logic is TDD'd in `src/execution` with property tests
  over every (A result × B result) combination including timeouts and kill-switch flips mid-flight.
- Natural follow-up (not in scope): the same pair with SL/TP per leg (a defined-risk straddle) reuses everything here; only (4) changes.
