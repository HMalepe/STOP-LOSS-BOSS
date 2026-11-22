# 06: Testing

## Pyramid
- **Unit (Vitest):** `src/domain` 100% of rules in 03 have a test named after the rule ID (`it("R2.3 sell SL must be above ask + d")`). Property tests (fast-check) for rounding, ladders and close-at assignment.
- **Integration:** executor against `MockBroker` with fault injection: random failures, rate-limit responses, latency, positions closing mid-batch.
- **E2E (Playwright, mobile viewport 390×844):** login with TOTP → set trigger → confirm → results; panic arm/fire; bulk ladder; expired plan; kill switch.
- **Load (`pnpm load`):** 1,000 positions on MockBroker with realistic latency (p50 120ms, p99 900ms) and a rate limit; assert completion time and zero duplicate actions.

## MockBroker requirements
- Deterministic with a seed. Configurable latency distribution, error rate per op, rate-limit bucket, stopsLevel/freezeLevel, digits.
- Enforces the same validity rules as a real server (rejects invalid stops with the real retcode), so bugs surface in tests.
- Records every call for assertions (e.g. "modify always carried the existing TP").

## Must-have test cases (non-exhaustive)
1. Modify SL only → TP preserved on every position (R2.7).
2. Close-at above market with mixed sides → exact TP/SL split (R3.2).
3. Close-at inside stop distance → rejected (R3.1).
4. Plan executed twice → second returns PLAN_ALREADY_EXECUTED, broker called once per item.
5. Price moves between preview and execute so plan becomes invalid → PRICE_MOVED, zero broker calls.
6. Rate-limited responses → executor backs off, all eventually succeed, no item attempted > 3 times.
7. Position closed by broker mid-batch → close-now counts it as success "already closed".
8. Ladder rounding produces duplicates → deduplicated + warning.
9. Volume not on step → rounded down + shown in preview.
10. Kill switch on → levels/closeAt/market/ladder blocked; close-now allowed.
11. Float edge: 1.1 + 0.2 style comparisons never misclassify (use points).
12. Live mode without live_enabled → LIVE_NOT_ENABLED.

## Gates
`pnpm verify` = typecheck + lint + unit + integration + build. CI runs it on every push. Coverage thresholds enforced in vitest config.

## Order Desk must-haves
13. A bulk entry never goes out without its requested SL; if SL is invalid at execute → item fails, no naked order (R5.3).
14. Scaled ladder lots sum matches the preview; each lot is on the volume step (R9.5).
15. Preset fired after price moved builds from the live quote, not the saved one (R9.6).
16. Spread above guard at execute → whole batch refused, zero broker calls (R9.4).
17. Risk preview total equals the sum of per-order risk; insufficient margin → blocked (R9.2–R9.3).
18. Group-tag management only touches orders with that tag (R9.1).

## Added in Phase 00 review
19. Spec fetch fails → plan refused with BROKER_UNAVAILABLE; no fallback to d = 0 (R0.1).
20. Netting account → entries/ladders refused with a reason; modify/close still allowed (R0.2).
21. Entry times out but the order actually landed (MockBroker "lost reply" fault) → reconcile finds it by magic/clientId, **no second order** (R6.5).
22. 429 with `recommendedRetryTime` → limiter pauses globally until that time; no item exceeds 3 attempts (R6.2).
23. `comment` + `clientId` > 26 chars → plan builder rejects before any broker call (R9.1).
24. `decodeMagic` property test: a manual trade (magic 0) or another EA's magic never matches a batch filter (R9.1).
25. Close-at with mixed sides → preview contains the bid/ask timing warning (R3.6).
26. MockBroker in "omit wipes level" mode: modify SL only on a position with a TP → TP still present afterwards (R2.7).
27. Break-even never moves an SL further from price (R8.3).

## Coverage map (after Phase 04, from the QA review)
| # | Status |
|---|---|
| 1 | plan.test (1,000 positions, every TP preserved) + load (exact TPs) |
| 2, 3, 11, 19, 25, 27 | domain tests |
| 4 | jobRunner.test (same planId twice; concurrent triple tap) |
| 5 | **Phase 06** (drift guard on the execute route) |
| 6 | executor.test (R6.1 max 3, backoff timing, 429 pause incl. late 429) |
| 7 | executor.test (closed mid-batch = done) |
| 8, 9, 13–18, 23, 24 | **Phase 08** (Order Desk) |
| 10, 12 | **Phase 05/06** (kill switch, live guard) |
| 20 | partial: margin mode parsed; refusal in Phase 08 |
| 21 | executor.test (ADR-0009 paths, property test) + load (late landings, zero duplicates) |
| 22 | partial: limiter + adapter; end-to-end with the server in Phase 06 |
| 26 | superseded by ADR-0008 (both levels always sent); contract suite checks "0 removes" on demo |
