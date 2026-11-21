# src/execution: the batch executor
- Credit-based rate limiter, bounded concurrency, retries (§6), reconcile-before-retry for entries (R6.5), idempotency, progress events.
- Talks to the broker only through `BrokerProvider`. TDD only. Coverage gate: 95% branches.
