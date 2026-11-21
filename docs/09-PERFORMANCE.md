# 09: Performance (the scalping requirement)

## The two latencies (explain these to the owner in the UI help)
1. **Trigger latency:** once SL/TP is set, the broker server executes it. Our app adds zero latency there.
2. **Apply latency:** time to push N modifications. This is our problem: N × per-call time ÷ concurrency, bounded by rate limits.
So the app's job is to make (2) as small as the broker and MetaApi allow, and to teach the user to set triggers early.

## Levers, in order of impact
1. **Warm streaming connection** (MetaApi SDK streaming/RPC connection kept open in the worker) instead of cold REST calls per request. Removes connection setup and cold starts.
2. **Concurrency tuned to the real rate limit.** Token-bucket limiter in `src/execution/rateLimiter.ts`. Start conservative; make rate and burst configurable; measure.
3. **Region co-location:** worker region ≈ MetaApi region ≈ broker server region.
4. **No-op skipping** (R2.8): don't send modifies that change nothing.
5. **Pre-flight in parallel:** fetch positions + quote + spec concurrently; cache spec per symbol (TTL 1h).
6. **Prioritise:** for close-at and SL changes, process positions closest to the trigger first (most at risk).
7. **Streaming progress** so the user sees it working; don't wait for all before showing anything.

## TO VERIFY (Claude Code: fill this table from official MetaApi docs and from measurement; never invent numbers)
| Item | Value | Source / how measured |
|---|---|---|
| MetaApi trade request rate limit (per account) | ? | |
| Max concurrent in-flight trade requests | ? | |
| Typical trade RPC latency (streaming) | ? | |
| Typical trade latency (REST) | ? | |
| Exness MT5 server stops/freeze level for target symbol | ? | |
| Broker limit on max open positions / orders | ? | |
| Throttle retcode(s) returned | ? | |

## Budgets (targets; revise after measurement)
- Preview: p95 < 800ms for 1,000 positions.
- Execute 100 modifies: p95 < 5s. 1,000: report measured; aim to be rate-limit-bound, not code-bound.
- UI interaction to visual feedback: < 100ms.

## Load test
`pnpm load` runs 1,000 positions on MockBroker configured with the verified limits and prints: total time, p50/p95 per call, retries, max concurrency observed, duplicates (must be 0).
