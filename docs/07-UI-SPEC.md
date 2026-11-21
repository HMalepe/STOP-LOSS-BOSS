# 07: UI Spec (phone-first, dark, thumb-reachable)

Design: dark trading-terminal feel, high contrast, 48px minimum tap targets, monospace numerals (`tabular-nums`), primary actions in the bottom half of the screen.
Colours: bg #0b0f14, card #141a22, line #232c38, accent #38bdf8, profit #22c55e, loss/danger #ef4444, warn #f59e0b.
Mode badge always visible top: MOCK (grey) / DEMO (amber) / LIVE (red, pulsing dot).

## Screens
1. **Login**: password → TOTP (6 numeric boxes, auto-advance, paste support).
2. **Dashboard** (home)
   - Sticky header: mode badge, symbol picker, bid/ask/spread live, connection dot.
   - Stats row: positions, floating P/L (coloured), margin level, pending orders.
   - Filter chips: All / Buys / Sells, "in profit only".
   - Action tabs (segmented): **Trigger · SL/TP · Orders · Helpers**
   - Fixed bottom: **CLOSE ALL NOW** (arm → "TAP AGAIN TO CLOSE 214" for 4s, haptic `navigator.vibrate` where supported).
3. **Trigger tab:** price input with −/+ nudge buttons (±1, ±10 points) and "use bid"/"use ask" chips → Preview.
4. **SL/TP tab:** two inputs (optional), entry as price OR points-from-market toggle → Preview.
5. **Orders tab:** Market (count, lot, side, SL/TP points) | Ladder (type, from, to, levels or step, lot, SL/TP points) | Cancel pending.
6. **Helpers tab:** Break-even (+N), Lock profit (N).
7. **Confirm sheet** (bottom sheet): plain sentence ("214 EURUSD positions will close at 1.09000. 180 as take profit, 34 as stop loss."), breakdown, warnings in amber, expiry countdown ring (30s), big Confirm button. LIVE mode: confirm requires press-and-hold 1s.
8. **Execution view:** progress bar (done/total), live ok/failed counters, streaming list; on finish, summary + "Retry failed (n)".
9. **History:** list of executions → detail table.
10. **Settings:** caps, kill switch (re-auth), TOTP recovery codes, account mode.

## States to design for
Loading (skeletons), empty (no positions), broker disconnected (banner + disabled actions except retry), plan expired (sheet auto-closes with toast), offline (PWA shell + "you're offline").

## PWA
Manifest with real icons (192/512 maskable), standalone display, theme colour, service worker caching ONLY the app shell (never API responses).
