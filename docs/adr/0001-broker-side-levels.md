# ADR-0001: Triggers live at the broker, not in our app
**Status:** accepted
**Context:** "Close everything at price X" could be done by our server watching price and firing closes, or by setting SL/TP at X on each position.
**Decision:** Set SL/TP at the broker. Each position gets X as TP or SL by side (03 §3).
**Consequences:** Fires with the app, phone or worker down. Broker-speed execution. Positions opened after setting aren't covered (UI must say so). SL fills may slip. A server-side watcher can be added later as an *additional* layer, never a replacement.
