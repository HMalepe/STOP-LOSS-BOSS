> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 04: Execution engine
Read: docs/03-TRADING-RULES.md §6–§7, docs/09-PERFORMANCE.md, docs/11-ORDER-DESK.md (speed path), ADR-0003.

**M1. Rate limiter.** Token bucket plus in-flight semaphore, configurable; tests assert the rate is never exceeded using a fake clock. /checkpoint.
**M2. Executor core.** execute(plan) → async iterator of progress/item/complete; bounded concurrency; priority ordering (closest to trigger first); abort support. /checkpoint.
**M3. Retries.** R6 policy, jittered backoff, retry-after, re-validate before retrying a modify, "already closed" = success for close. /checkpoint.
**M4. Idempotency + JobRunner.** Execution keyed by planId; InProcessRunner. Test: double execute = one set of broker calls. /checkpoint.
**M5. Load harness.** `pnpm load`: 1,000 items on MockBroker with realistic latency, 5% retryable errors and a rate limit. Report total time, p50/p95, retries, max concurrency, duplicates (must be 0). /checkpoint.

Phase end: /safety-review plus the sre-reliability and qa-lead agents. Fix. /handoff.
