# ADR-0008: Broker wire policy (how the adapter talks to MetaApi)
**Status:** accepted 2026-11-22
**Context:** Reading `metaapi.cloud-sdk@29.3.4` showed: `modifyPosition` drops an unset level from the wire request, and what the server
does with a missing level is undocumented; trade calls are never retried by the SDK, while reads are retried with waits of up to 30 s;
the default request timeout is 60 s; ids are numbers in SDK types and strings in trade calls.
**Decision:**
1. Every modify sends **both** SL and TP as numbers: the plan's value, or `0` for "none" (`null` in the domain). Never omit a level.
   This makes the result independent of the undocumented omission behaviour, and it is exactly what the preview showed.
2. Every broker call has an adapter-level timeout (config, default 8 s for trades, 5 s for reads). On a timeout the adapter returns a
   result marked `ambiguous: true` for entries (R6.5) and `retryable: true` for modify/close/cancel.
3. Results are normalised into one `TradeResult` with the numeric code, string code, message, latency and a class from `retcodes.ts`.
   Thrown `TradeError`s become results, never exceptions. Unknown codes are `final` (R6.4).
4. Reads for planning come from the streaming `terminalState`; RPC reads only if the stream isn't synchronized.
5. All ids are strings inside our system.
**Consequences:** Removes the riskiest unknown from the [T] list (the omitted-level behaviour no longer matters). A concurrent edit made
elsewhere between preview and execute would be overwritten by the plan's values; the drift guard (§7, Phase 04) re-reads state first.
