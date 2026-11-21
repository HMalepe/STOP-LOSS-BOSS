# 03: Trading Rules (source of truth)

Every rule here becomes a pure function in `src/domain` with tests named after the rule ID.

## §0 Definitions
- **Buy** closes at **bid**. **Sell** closes at **ask**. So `ref(pos) = isBuy ? bid : ask`.
- `point` = symbol point size. `digits` = decimal places. `stopsLevel` (points) = min distance from ref for SL/TP. `freezeLevel` (points) = distance inside which modifications are refused.
- `d = max(stopsLevel, freezeLevel) * point` (+ configurable safety buffer, default 2 points).
- All prices are rounded to `digits` with `roundToTick` **before** validation. Compare in integer points: `toPoints(p) = Math.round(p / point)`.

## §1 Filters
Position matches if symbol equals AND (side = ALL or matches) AND (magic matches if given) AND (inProfitOnly → profit > 0).

## §2 Level validity (R2.x)
- R2.1 Buy SL valid ⇔ `sl < ref − d`
- R2.2 Buy TP valid ⇔ `tp > ref + d`
- R2.3 Sell SL valid ⇔ `sl > ref + d`
- R2.4 Sell TP valid ⇔ `tp < ref − d`
- R2.5 If both SL and TP are given for a buy: `sl < tp`; for a sell: `sl > tp` (implied by the above, assert anyway).
- R2.6 A plan is valid only if every item is valid. Errors are grouped per side with the boundary price, e.g. "Sell SL must be above 1.08670".
- R2.7 **Preserve:** the modify request always carries both levels: new value if set, else the position's current value, else omitted. (MT replaces both on modify; omitting can wipe one.) Test this explicitly.
- R2.8 No-op skip: if the new level equals the current level (in points), skip the item and report "unchanged", with no broker call.

## §3 Close-at-price trigger (R3.x)
For price X and position p:
- R3.1 If `|X − ref| ≤ d` → reject: "too close, use Close All Now".
- R3.2 `above = X > ref`. Buy: above → TP, below → SL. Sell: above → SL, below → TP.
- R3.3 Only the assigned level changes; the other is preserved (R2.7).
- R3.4 Preview reports counts asTP / asSL and buys / sells.
- R3.5 Note in UI: positions opened after setting are not covered.

## §4 Close now (R4.x)
- R4.1 Close by position id (`POSITION_CLOSE_ID`) at market; never a partial close in v1.
- R4.2 Kill switch does NOT block this.
- R4.3 Optional cancel pending orders of the same filter after positions.
- R4.4 Retry retryable failures (requote, price changed, off quotes, timeout, too many requests) per §6.

## §5 Bulk orders (R5.x)
- R5.1 Volume: `volumeMin ≤ v ≤ volumeMax`, rounded DOWN to `volumeStep`. Reject if rounding changes it by more than a step; show the effective lot.
- R5.2 Caps: `count ≤ MAX_ORDERS_PER_ACTION` (default 100), `count × v ≤ MAX_TOTAL_LOTS` (default configurable). Over cap → reject.
- R5.3 Market entries with SL/TP: validate SL/TP against the entry ref (buy ref = ask at entry for distance purposes, then rule §2 using closing side). On reject at entry, retry once without levels? **NO.** Never place an order without the requested stop. Fail the item.
- R5.4 Ladder: from A to B inclusive, N levels: `price_i = A + i*(B−A)/(N−1)`, rounded to tick, deduplicated after rounding (report if fewer than N remain).
  Or step mode: every K points from A toward B.
- R5.5 Pending type must be consistent with price vs market: Buy Limit below ask, Buy Stop above ask, Sell Limit above bid, Sell Stop below bid, all at least `d` away. Invalid levels → reject plan, listing them.
- R5.6 Per-level SL/TP given as offsets in points from the level price.

## §6 Retry policy (R6.x)
- Retryable: requote, price changed, price off, connection/timeout, too many requests (rate limit). Verify the exact MetaApi string/numeric codes and record them in `src/broker/retcodes.ts`.
- Non-retryable: invalid stops, invalid volume, market closed, no money, trade disabled, position not found (report "already closed": counts as success for close-now).
- Max 3 attempts, backoff 150ms × 2^n ± 30% jitter; respect any `retry-after`.
- Before retrying a modify, re-fetch the quote and re-validate; if now invalid, fail with reason (don't push a bad stop).

## §7 Drift guard
At execute time, re-read the quote. If any item's validity flipped since preview, abort the whole plan before the first broker call and return "price moved, re-preview". Configurable max drift in points (default: re-validate always).

## §8 Break-even helpers (F5)
- BE: `sl = openPrice + (isBuy ? +N : −N) * point`; must pass R2.1/R2.3; else skip with reason "not far enough in profit".
- Lock: `sl = ref − N*point` (buy) / `ref + N*point` (sell); only in-profit positions; must pass §2.
