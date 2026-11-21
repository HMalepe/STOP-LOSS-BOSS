# src/broker: the only door to the broker
- The only folder allowed to import `metaapi.cloud-sdk` (lint-enforced everywhere else).
- `BrokerProvider` interface, `MockBroker`, `MetaApiBroker`, Zod schemas for broker data, `retcodes.ts`.
- Everything that comes back from the broker is parsed with Zod before anyone else sees it.
