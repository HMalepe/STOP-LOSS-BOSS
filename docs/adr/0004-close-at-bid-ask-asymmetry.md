# ADR-0004: Close-at-price is honest about bid/ask timing
**Status:** accepted 2026-11-21. `raw` ships in v1; `spreadAligned` is deferred to v1.1 as an opt-in toggle.
**Context:** One trigger price X goes onto buys and sells. Buy SL/TP trigger when **bid** reaches X; sell SL/TP trigger when **ask**
reaches X. With a 1-point spread, sells on a rising market close one spread before buys. On news, spreads can widen 10 to 50×, so one
side can be stopped out while the other never triggers. The owner reads "close all at X" as "flat at X", and that isn't what happens.
**Decision:** Default `raw`: put exactly X on every position (the broker-side behaviour MT5 users expect), and make the preview state the
timing in plain words whenever both sides are present (R3.6). Offer `spreadAligned` later as an explicit toggle: sells get X + current spread,
so both sides trigger at roughly bid = X, with the shifted price shown.
**Consequences:** No silent surprise. `spreadAligned` is only as good as the spread at setting time; the UI must say so. Neither mode
removes slippage on SL fills (ADR-0001).
