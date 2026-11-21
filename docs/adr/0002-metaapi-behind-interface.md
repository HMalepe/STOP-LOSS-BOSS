# ADR-0002: MetaApi behind a BrokerProvider interface
**Status:** accepted
**Context:** Exness has no public retail trading API; MT5 access goes through MetaApi. Vendor lock-in and testability are concerns.
**Decision:** All broker access goes through `BrokerProvider`. Implementations: `MockBroker` (tests, demo UI), `MetaApiBroker`. A future `Mt5BridgeBroker` (self-hosted MT5 + EA on a VPS) can drop in.
**Consequences:** Domain and executor are fully testable offline. One file to change if the vendor changes.
