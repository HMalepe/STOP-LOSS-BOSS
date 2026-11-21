> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 02: Domain core (pure trading logic). The heart of it. TDD only.
Read: docs/03-TRADING-RULES.md line by line, before each milestone, for the rules it touches.
Use the test-engineer agent to write failing tests named by rule ID before implementing.

**M1. Types + price.** `types.ts` (Position, PendingOrder, Quote, SymbolSpec, Filter, PlanItem union, Plan) and `price.ts` (roundToTick, toPoints, fromPoints, compare). Property tests: roundToTick idempotent; point comparisons stable on float edge cases. /checkpoint.
**M2. Level rules.** ref(), stopDistance(), validateLevels() for R2.1 to R2.8 with exact-boundary, one-inside and one-outside tests for buys AND sells. Preserve rule R2.7. /checkpoint.
**M3. Close-at.** assignCloseAt() for R3.x plus a fast-check property "assigned level is always on the correct side". /checkpoint.
**M4. Plan builder.** buildPlan() for levels, closeAt and close; deterministic, grouped errors (R2.6), no-op skip (R2.8), breakdown counts. /checkpoint.
**M5. Helpers.** breakeven(), lock() (§8). /checkpoint.

Phase end: a table of rule ID → test → pass, then /safety-review and the trading-systems-engineer agent. Fix findings. /handoff.
