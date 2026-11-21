# ADR-0006: Ship in three slices; LIVE only at the end
**Status:** proposed, owner to confirm (PROGRESS Q3)
**Context:** 10 phases is a long road before the owner gets anything usable. The money-saving core (bulk SL/TP, close at price, close now)
is ~40% of the work; ladders, presets, risk preview and the worker are the rest.
**Decision:** v1 "Usable" = F1, F2, F3, F4a, F6, F7 on mock and demo (Phases 1 to 7 with a thin UI). v1.1 "Order Desk" = ladders, presets,
batch management, risk preview, spread guard. v1.2 "Live" = streaming worker, hardening, go-live checklist. Phase prompts stay as written;
this ADR only reorders when the owner gets to use things, and keeps LIVE behind v1.2 whatever the slice.
**Consequences:** The owner is using the tool on demo weeks earlier, and real usage feeds back into the Order Desk design.
The cost is that Phase 07 UI gets built twice (thin, then full). That's acceptable; the UI layer is the cheapest to change.
