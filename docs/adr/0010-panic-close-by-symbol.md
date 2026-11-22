# ADR-0010: One-request panic close (proposed, needs demo verification)
**Status:** proposed 2026-11-22. Not built. Needs the [T] checks below on an Exness demo first.
**Context:** Close-now on 1,000 positions is credit-bound at ~22 s (09-PERFORMANCE: 1,000 × 10 credits against 4,500 / 10 s).
The MetaApi SDK has `closePositionsBySymbol(symbol, options)` (verified in metaapi.cloud-sdk@29.3.4 type definitions): one trade
request that closes every position on a symbol. That would be 10 credits instead of 10,000, i.e. about one round trip.
**Proposal:** For "close everything on SYMBOL" with no side/magic/in-profit filter, offer a "Panic: one request" path that sends
`closePositionsBySymbol`, then reconciles from the stream: every position that is gone = done, anything still open = retried by ticket
through the normal executor. Filtered closes keep using per-ticket closes.
**Must verify on demo before building:** does MT5/MetaApi execute it as one server-side operation or loop internally; what the response
contains (one code? per-position?); behaviour with 1,000 positions (time, partial failures, LIMIT/FROZEN cases); credit cost; whether
it also touches pending orders. Until then: not offered.
**Consequences if adopted:** close-now goes from ~22 s to roughly the time of one request plus reconcile, which matters most in exactly
the moment it's used. Per-position results come from reconcile instead of the call, so the UI shows them a moment later.
