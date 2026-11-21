# 11: Order Desk (the game-changer feature)

The edge: **one tap fires a whole position structure** (many entries, all with stops, at exact prices) faster than anyone
can do it by hand in MT5. Then the same tool manages and exits the lot in one tap.

## Concepts
- **Order:** one market or pending order with optional SL/TP.
- **Batch:** many orders built from one instruction (count × lot, or a ladder).
- **Preset:** a saved batch recipe the owner fires in one tap. Example "Scalp 10": BUY, 10 × 0.05, SL 150 pts, TP 300 pts.
- **Group tag:** every order from one batch gets a **batch magic number** (`APP_MAGIC_PREFIX × 10^9 + batchSeq`) so it can be
  managed as a unit later ("move SL on this batch only", "close this batch"). Matching is on magic only; the `OD:<short>` comment
  is for humans reading MT5. MetaApi caps `comment` + `clientId` at 26 characters. Full rule: 03-TRADING-RULES R9.1, ADR-0005.
- **Hedging account required** for batches (R0.2). On netting, N entries become one position.

## Features
| ID | Feature | Notes |
|---|---|---|
| OD1 | Bulk market entries | N × lot, side, SL/TP in points or price. Rules §5. |
| OD2 | Pending ladder | Limit/stop, A to B by N levels or every K points; lot per level, or **scaled** lots (flat / increasing / decreasing). |
| OD3 | Presets | Create, edit, reorder, and pin to the home screen as big buttons. Fire = preview → confirm (hold in LIVE). |
| OD4 | Quick-fire buttons | Pinned presets plus BUY/SELL side toggle on the dashboard. Two taps from unlock to live orders. |
| OD5 | Batch management | Per group tag: move SL/TP, break-even, close, cancel the rest of a ladder. |
| OD6 | Risk preview | Before confirm: total lots, money at risk to SL (per order and total, in account currency, from symbol tick value), margin required vs free margin. Block if margin is insufficient. |
| OD7 | Caps | Max orders per action, max total lots, max risk per action (% of equity). All configurable, re-auth to change. |
| OD8 | Spread guard | Optional: refuse to fire a batch if spread > X points (scalpers get killed by spread spikes). |

## Rules
Moved into `03-TRADING-RULES.md` §9 (R9.1 to R9.6) during Phase 00 so there is one source of truth. Don't duplicate them here.

## Speed path for OD1 (what makes it feel instant)
- The worker holds a warm streaming connection (ADR-0003). Quote and spec are cached and refreshed on stream.
- Preview is computed in < 300ms from cached state; execute re-checks the quote (drift guard) and fires at the max safe rate.
- Orders go out highest priority first; progress streams to the phone as fills come back.
