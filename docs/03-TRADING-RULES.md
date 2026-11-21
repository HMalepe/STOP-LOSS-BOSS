# 03: Trading Rules (source of truth)

Every rule here becomes a pure function in `src/domain` with tests named after the rule ID.
Facts marked **[V]** were verified against official docs on 2026-11-21 (sources in `docs/09-PERFORMANCE.md`).
Facts marked **[T]** must be tested on an Exness demo account through MetaApi in Phase 3 before anything goes live.

## §0 Definitions
- **Buy** closes at **bid**. **Sell** closes at **ask**. So `ref(pos) = isBuy ? bid : ask`.
- `point` = symbol point size. `digits` = decimal places. `stopsLevel` (points) = min distance from ref for SL/TP. `freezeLevel` (points) = distance inside which modifications are refused.
- `d = max(stopsLevel, freezeLevel) * point` (+ configurable safety buffer, default 2 points).
- All prices are rounded to `digits` with `roundToTick` **before** validation. Compare in integer points: `toPoints(p) = Math.round(p / point)`.
- R0.1 **No spec, no plan.** If the symbol spec (point, digits, stopsLevel, freezeLevel, volume limits) can't be loaded, refuse the plan with `BROKER_UNAVAILABLE`. Never fall back to `d = 0` or any default. (The v1 prototype did this; it is a bug.)
- R0.2 **Hedging accounts only for multi-position features.** On a netting account, N entries collapse into one position and every "batch" rule becomes meaningless. At connect, read the account's margin mode [T: confirm MetaApi field name]; if not hedging, disable entries/ladders and show why. Modify/close/trigger still work.

## §1 Filters
Position matches if symbol equals AND (side = ALL or matches) AND (magic matches if given) AND (inProfitOnly → profit > 0).
- R1.1 `batch` filter (Order Desk): matches if the position's magic decodes to the given batch id (see R9.1).

## §2 Level validity (R2.x)
- R2.1 Buy SL valid ⇔ `sl < ref − d`
- R2.2 Buy TP valid ⇔ `tp > ref + d`
- R2.3 Sell SL valid ⇔ `sl > ref + d`
- R2.4 Sell TP valid ⇔ `tp < ref − d`
- R2.5 If both SL and TP are given for a buy: `sl < tp`; for a sell: `sl > tp` (implied by the above, assert anyway).
- R2.6 A plan is valid only if every item is valid. Errors are grouped per side with the boundary price, e.g. "Sell SL must be above 1.08670".
- R2.7 **Preserve:** the modify request always carries both levels: new value if set, else the position's current value, else omitted.
  [V] MQL5 lists both `sl` and `tp` as required fields for `TRADE_ACTION_SLTP`. [V] MetaApi marks both optional on `POSITION_MODIFY`
  and does **not** document what an omitted field does. So: always send both, and MockBroker must model the worst case
  (an omitted level gets wiped) so a missing field fails tests. [T] Confirm real omission behaviour on demo and record it in ADR-0002.
- R2.8 No-op skip: if the new level equals the current level (in points), skip the item and report "unchanged", with no broker call.
  If the broker still answers `TRADE_RETCODE_NO_CHANGES` (10025) it counts as success [V: MetaApi lists 10025 as a success code].

## §3 Close-at-price trigger (R3.x)
For price X and position p:
- R3.1 If `|X − ref| ≤ d` → reject: "too close, use Close All Now".
- R3.2 `above = X > ref`. Buy: above → TP, below → SL. Sell: above → SL, below → TP.
- R3.3 Only the assigned level changes; the other is preserved (R2.7).
- R3.4 Preview reports counts asTP / asSL and buys / sells.
- R3.5 Note in UI: positions opened after setting are not covered.
- R3.6 **Bid/ask asymmetry (ADR-0004).** Buy levels trigger on **bid**, sell levels trigger on **ask**. One X therefore does not close
  everything at the same instant: on a rising market sells reach X (ask = X) one spread before buys (bid = X), and on a falling
  market the reverse. A spread spike can trigger one side and not the other. The preview must say this in plain words whenever the
  plan contains both buys and sells, e.g. "Sells close when ASK hits 1.09000, buys when BID hits it. Spread now 0.8 pts."
  Default mode is `raw` (exactly X on both sides). Optional `spreadAligned` mode (owner decision pending, PROGRESS Q1)
  shifts sell levels by the current spread so both sides trigger at roughly bid = X; it must show the shifted price and
  warn that spread changes after setting are not tracked.

## §4 Close now (R4.x)
- R4.1 Close by position id (`POSITION_CLOSE_ID`) at market; never a partial close in v1.
- R4.2 Kill switch does NOT block this.
- R4.3 Optional cancel pending orders of the same filter after positions.
- R4.4 Retry retryable failures per §6.
- R4.5 `TRADE_RETCODE_POSITION_CLOSED` (10036) or "position not found" → success, reported as "already closed".
- R4.6 Order: positions with the largest absolute floating loss first (most money at risk), then the rest.

## §5 Bulk orders (R5.x)
- R5.1 Volume: `volumeMin ≤ v ≤ volumeMax`, rounded DOWN to `volumeStep`. Reject if rounding changes it by more than a step; show the effective lot.
- R5.2 Caps: `count ≤ MAX_ORDERS_PER_ACTION` (default 100), `count × v ≤ MAX_TOTAL_LOTS` (default configurable). Over cap → reject.
- R5.3 **Market entries with SL/TP.** SL/TP are validated with §2 using the side's **closing** price, because that is what the broker
  checks a stop against: a buy's SL/TP against **bid**, a sell's against **ask**. (Replaces the earlier wording "buy ref = ask",
  which contradicted itself.) Points-based SL/TP are converted to prices from the **expected fill** (buy: ask, sell: bid), then
  rounded and validated. If the level is rejected at entry, fail the item. **Never** retry without the stop.
- R5.4 Ladder: from A to B inclusive, N levels: `price_i = A + i*(B−A)/(N−1)`, rounded to tick, deduplicated after rounding (report if fewer than N remain). N = 1 → single level at A.
  Or step mode: every K points from A toward B; B is included only if it lands exactly on a step.
- R5.5 Pending type must be consistent with price vs market: Buy Limit below ask, Buy Stop above ask, Sell Limit above bid, Sell Stop below bid, all at least `d` away. Invalid levels → reject plan, listing them.
- R5.6 Per-level SL/TP given as offsets in points from the level price.

## §6 Retry policy (R6.x)
[V] MT5 return codes (`ENUM_TRADE_RETURN_CODES`); these go into `src/broker/retcodes.ts` as the single table:

| Code | Name | Class |
|---|---|---|
| 10008 / 10009 / 10010 | PLACED / DONE / DONE_PARTIAL | success (DONE_PARTIAL on an entry → report the partial fill, no retry) |
| 10025 | NO_CHANGES | success (R2.8) |
| 10036 | POSITION_CLOSED | success for close-now, failure for modify ("already closed") |
| 10004 / 10020 / 10021 | REQUOTE / PRICE_CHANGED / PRICE_OFF | retryable |
| 10012 / 10031 | TIMEOUT / CONNECTION | **ambiguous**, see R6.5 |
| 10024 + HTTP 429 | TOO_MANY_REQUESTS | retryable after `recommendedRetryTime` |
| 10006 / 10014 / 10016 / 10017 / 10018 / 10019 / 10029 / 10033 / 10034 | REJECT / INVALID_VOLUME / INVALID_STOPS / TRADE_DISABLED / MARKET_CLOSED / NO_MONEY / FROZEN / LIMIT_ORDERS / LIMIT_VOLUME | non-retryable |

- R6.1 Max 3 attempts, backoff 150ms × 2^n ± 30% jitter.
- R6.2 On a 429, wait until the error's `metadata.recommendedRetryTime` [V] (ISO timestamp), not the computed backoff, and slow the shared limiter for everyone, not just this item.
- R6.3 Before retrying a modify, re-fetch the quote and re-validate; if now invalid, fail with reason (don't push a bad stop).
- R6.4 Unknown codes are non-retryable and logged with the raw code for later classification.
- R6.5 **Timeouts on entries are not retryable blind.** A timeout or connection drop on `placeMarket` / `placePending` may mean the order
  went through and only the reply was lost. Retrying can double the position. Before any retry of an entry: reconcile, i.e. re-read
  positions/orders and look for one carrying this item's tag (R9.1: magic + `clientId`). Found → mark success with that ticket.
  Not found → retry. Can't read → fail the item as "unknown, check manually". Modifies and closes are safe to retry
  (re-sending the same levels is a no-op; closing a closed position returns 10036).

## §7 Drift guard
At execute time, re-read the quote. If any item's validity flipped since preview, abort the whole plan before the first broker call and return "price moved, re-preview". Configurable max drift in points (default: re-validate always).

## §8 Break-even helpers (F5)
- R8.1 BE: `sl = openPrice + (isBuy ? +N : −N) * point`; must pass R2.1/R2.3; else skip with reason "not far enough in profit".
- R8.2 Lock: `sl = ref − N*point` (buy) / `ref + N*point` (sell); only in-profit positions; must pass §2.
- R8.3 Neither helper may move an existing SL to a worse level (further from price). If it would, skip with "SL already better".

## §9 Order Desk (batch identity, risk, guards)
- R9.1 **Batch identity (ADR-0005).** Every order from a batch carries:
  - `magic = APP_MAGIC_PREFIX × 10^9 + batchSeq` (batchSeq < 10^9; result stays below 2^53 so JS numbers are exact). App-owned = `floor(magic / 10^9) === APP_MAGIC_PREFIX`. [T] confirm MetaApi accepts `magic` on market and pending orders.
  - `comment = "OD:" + batchShort` (human-readable only, never used to match).
  - `clientId = <planShort><itemIndex>` for reconciliation (R6.5).
  - [V] MetaApi: `comment` + `clientId` together must be **≤ 26 characters**. Enforce it in the plan builder, with a test.
  - Matching is always on `magic`. Comments can be truncated or rewritten by the broker; magic is a number set once at entry.
- R9.2 Risk to SL per order = |entry − SL| / tickSize × tickValue × lots. Verify MetaApi/MT5 field names for tick value. Never guess.
- R9.3 Margin check uses the broker's margin calculation if MetaApi exposes it; otherwise block with "can't verify margin" rather than estimate (owner may override per action in demo only).
- R9.4 Spread guard compares (ask − bid) in points to the configured max at execute time, not preview time.
- R9.5 Scaled ladder lots: flat = same; increasing/decreasing = linear from lotStart to lotEnd, each rounded down to volumeStep; total shown in preview.
- R9.6 Preset firing always builds a fresh plan from live quote/spec; presets store recipes, never prices relative to a stale quote (unless absolute-price preset, flagged as such).
