# 01: Product Requirements

## Problem
The owner scalps one symbol with many simultaneous positions (50 to 1,000+). Changing stops one by one in MT5 is too slow:
while he edits trade 1 of 200, price moves. He needs one action that hits every position at once, from his phone,
without opening MetaTrader.

## User
One owner-operator (single user at launch, design for multi-account later). Uses a phone, often mid-trade, under time pressure.
Needs big targets, few taps, zero ambiguity about what will happen.

## Features

### F1: Bulk SL / TP
Set the same stop loss and/or take profit on every position matching a filter (symbol, side, optional magic number / comment, optional "in profit only").
- Either field optional; blank = leave unchanged.
- Server validates each position (see 03-TRADING-RULES §2). Any invalid position → whole plan rejected with a reason per side.
- **Acceptance:** 1,000 positions, all valid → all modified, per-position result shown, untouched level preserved on every position.

### F2: Close all at price (trigger)
One price X. Every matching position gets X as TP or SL, whichever side of market X is (03-TRADING-RULES §3).
Held broker-side, so it fires with the app closed.
- Show split before execute: "39 as TP, 13 as SL".
- Refuse if X is inside the stop level for any position; suggest Close All Now.
- **Acceptance:** mixed buys/sells, X above market → buys TP=X, sells SL=X; X below → the reverse.

### F3: Close all now (panic)
Market-close every matching position; optionally cancel pending orders. Two-step confirm (arm → fire within 4s).
- Works even when the kill switch is on.
- Executes with maximum safe concurrency (09-PERFORMANCE).
- **Acceptance:** 1,000 positions closed with per-position results; failed ones retried automatically up to the retry policy, then listed with a "retry failed" button.

### F4: Bulk order placement
- **F4a, bulk market entries:** N orders × lot size, side, symbol, optional SL/TP on each (attached at entry, not modified later).
- **F4b, pending ladder:** buy/sell limit or stop orders from price A to price B, N levels or every K points, lot per level, optional SL/TP offset per level.
- **F4c, cancel pending:** all, by symbol, by side, by type.
- Hard caps: max orders per action, max total lots (config, default conservative), shown in preview.
- **Acceptance:** ladder of 20 buy limits 1.0800 to 1.0780 previews exact prices (rounded to symbol digits), places all, reports per order.

### F5: Break-even and offset helpers (Phase 8 stretch)
- "SL to break-even (+N points)": each position gets SL = its own open price ± N. Only for positions far enough in profit; others skipped and listed.
- "Lock profit": SL = current price ∓ N points for all in-profit positions.

### F6: Dashboard
Live count, floating P/L, bid/ask, spread, open orders count, margin level, account mode badge (MOCK / DEMO / LIVE).

### F7: History and audit
List of past actions: time, type, plan summary, success/fail counts, latency; tap to see per-position detail.

## Out of scope (v1)
Strategy automation, signals, copy trading, multiple brokers at once, native apps.

## Success metrics
- Tap Execute to broker-acknowledged for 100 positions: p95 < 5s (target; confirm against measured MetaApi limits, see 09).
- Zero instances of an SL/TP being wiped unintentionally (enforced by test + audit check).
- Zero executes that differ from their preview.

## F8: Order Desk (headline feature)
Bulk entries, ladders with scaled lots, one-tap presets, quick-fire buttons, batch management by group tag, risk/margin preview,
caps and spread guard. Full spec: **docs/11-ORDER-DESK.md**. Built in Phase 08.
