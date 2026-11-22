# ADR-0009: Entry reconciliation protocol (no duplicate positions)
**Status:** accepted 2026-11-22 (implemented in Phase 04 executor; broker support done in Phase 03)
**Context:** Phase 03 board review. An entry can time out on our side while the MetaApi SDK is still holding it: the SDK waits for a
connected instance with no time limit before sending, so the order can be placed minutes later ("zombie"). Market orders in flight show
up as ORDER_TYPE_BUY/SELL in the orders list, not as positions. The stream also lags behind a fill by up to a second or two. A naive
"timeout → not found → retry" doubles the position.
**Decision:**
1. Every entry carries a unique `clientId` (`<planShort><itemIndex>`, comment + clientId ≤ 26 chars, R9.1).
2. A timed-out trade returns `settled`: a promise of the real outcome. The executor waits on it (bounded) before doing anything else.
3. `BrokerProvider.reconcile(clientIds)` returns position / order / inFlight / notFound for each id, from the same stream snapshot.
   One call per wave (indexed by clientId), so 1,000 items stay O(n).
4. Retry an entry only when its first attempt is known not to have landed: `settled` resolved to a definite failure AND reconcile says
   `notFound` after a bounded lag poll. Every other path ends as "unknown, check manually": surfaced in the UI and audit, never retried.
5. Positions that filled and then closed before reconcile (SL hit instantly) won't be in the book: history lookup by clientId is a
   Phase 09 addition; until then they are "unknown, check manually".
**Consequences:** A rare unknown needs a human glance, which is far cheaper than an unintended double position. The executor's
retry logic for entries is the strictest path in the system and gets its own property tests.

## Amendments (2026-11-22, Phase 04 board review)
- Settle waits and reconcile polls run **off the worker**: an item that must wait frees its worker for the next item, and the run waits
  for it before completing. A hung broker can no longer stall a 1,000-item close-now for an hour.
- A timed-out request keeps its **in-flight slot** until it settles or the window passes, so the cap reflects what MetaApi really has.
- **close/cancel never wait on `settled`**: closing by ticket is idempotent, so they resend after backoff and the book check decides.
- **modify** waits on `settled`; a modify timeout with no `settled` ends "unknown" (a blind resend could land after a newer plan).
- Reconcile finding **more than one** ticket for a clientId ends "unknown: duplicate", never a clean "done".
- A plan containing the same target twice: later copies are refused before anything is sent.
- `reconcilePolls` is clamped to at least 1.
