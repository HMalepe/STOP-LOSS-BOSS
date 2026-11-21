> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 08: Order Desk (the game-changer)
Read: docs/11-ORDER-DESK.md fully, docs/03-TRADING-RULES.md §5 and §8. First milestone adds §9 to 03 from the reserved IDs in 11.

**M1. Rules first.** Write §9 into 03-TRADING-RULES.md (R9.1 to R9.6, refined with the verified MetaApi field names). Then the trading-systems-engineer agent reviews it. /checkpoint.
**M2. Domain: bulk market + caps + risk.** OD1, OD6, OD7, OD8 as pure functions; TDD by rule ID; R5.3 "never enter without the requested stop" tested. /checkpoint.
**M3. Domain: ladders.** OD2 levels and step modes, scaled lots (R9.5), pending type vs market (R5.5), rounding and dedupe. Property tests. /checkpoint.
**M4. Presets backend.** Table, CRUD API, fire = build a fresh plan from live data (R9.6), group tags (R9.1). /checkpoint.
**M5. Batch management.** OD5: filter by group tag → move SL/TP, break-even, close, cancel remaining ladder. /checkpoint.
**M6. Orders tab UI.** Market | Ladder | Cancel, with a risk preview showing total lots, money at risk, and margin vs free margin. /checkpoint.
**M7. Quick-fire.** Pinned preset buttons and side toggle on the dashboard; two taps from unlock to confirm sheet. E2E. /checkpoint.
**M8. Speed check.** `pnpm load` for 100 × market entries with SL/TP on MockBroker; record the results in 09. /checkpoint.

Phase end: full /board-review. Fix all must-fix items. /handoff.
