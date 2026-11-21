> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 03: Broker adapter
Read: docs/02-ARCHITECTURE.md (interfaces), docs/06-TESTING.md (MockBroker), docs/09-PERFORMANCE.md, ADR-0002.

**M1. Verify MetaApi (no code).** The trading-systems-engineer agent checks the official MetaApi docs: SDK package/version, streaming vs RPC connection, method names for modify/close/market/pending/cancel, response shape, numeric and string retcodes, rate limits, tick value / margin calc fields. Fill the TO VERIFY table in 09 with links. Unknown = "not documented", never a guess. /checkpoint.
**M2. Interface + schemas.** `BrokerProvider.ts`, `schemas.ts` (Zod parsing broker data into domain types), `retcodes.ts` (retryable vs final). /checkpoint.
**M3. MockBroker.** Seeded, latency distribution, error injection, rate-limit bucket, enforces stop/freeze levels with real retcodes, call recorder, account with margin and tick value. /checkpoint.
**M4. MetaApiBroker.** One connection per process, reconnect with backoff, health check, timeouts on every call. /checkpoint.
**M5. Contract tests.** One shared suite for both providers (MetaApi run only when demo creds are set). /checkpoint.

Phase end: /board-review (architect, trading systems, SRE). /handoff.
