# 11: Order Desk (the game-changer feature)

The edge: **one tap fires a whole position structure** (many entries, all with stops, at exact prices) faster than anyone
can do it by hand in MT5. Then the same tool manages and exits the lot in one tap.

## Concepts
- **Order:** one market or pending order with optional SL/TP.
- **Batch:** many orders built from one instruction (count × lot, or a ladder).
- **Preset:** a saved batch recipe the owner fires in one tap. Example "Scalp 10": BUY, 10 × 0.05, SL 150 pts, TP 300 pts.
- **Group tag:** every order from one batch gets the same `comment` (e.g. `OD:<shortId>`) and the app's magic number, so it can be
  managed as a unit later ("move SL on this batch only", "close this batch").

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

## Rules (add to 03-TRADING-RULES as §9 during Phase 8; IDs reserved here)
- R9.1 Every order from a batch carries the batch's group tag in `comment` and the app magic number.
- R9.2 Risk to SL per order = |entry − SL| / tickSize × tickValue × lots. Verify MetaApi/MT5 field names for tick value. Never guess.
- R9.3 Margin check uses the broker's margin calculation if MetaApi exposes it; otherwise block with "can't verify margin" rather than estimate (owner may override per action in demo only).
- R9.4 Spread guard compares (ask − bid) in points to the configured max at execute time, not preview time.
- R9.5 Scaled ladder lots: flat = same; increasing/decreasing = linear from lotStart to lotEnd, each rounded down to volumeStep; total shown in preview.
- R9.6 Preset firing always builds a fresh plan from live quote/spec; presets store recipes, never prices relative to a stale quote (unless absolute-price preset, flagged as such).

## Speed path for OD1 (what makes it feel instant)
- The worker holds a warm streaming connection (ADR-0003). Quote and spec are cached and refreshed on stream.
- Preview is computed in < 300ms from cached state; execute re-checks the quote (drift guard) and fires at the max safe rate.
- Orders go out highest priority first; progress streams to the phone as fills come back.
