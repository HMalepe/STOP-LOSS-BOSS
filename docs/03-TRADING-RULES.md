# 03: Trading Rules (source of truth)

Every rule here becomes a pure function in `src/domain` with tests named after the rule ID.
Facts marked **[V]** were verified against official docs on 2026-11-21 (sources in `docs/09-PERFORMANCE.md`).
Facts marked **[T]** must be tested on an Exness demo account through MetaApi in Phase 3 before anything goes live.

## §0 Definitions
- **Buy** closes at **bid**. **Sell** closes at **ask**. So `ref(pos) = isBuy ? bid : ask`.
- `point` = symbol point size. `digits` = decimal places. `stopsLevel` (points) = min distance from ref for SL/TP. `freezeLevel` (points) = distance inside which modifications are refused.
- `d = max(stopsLevel, freezeLevel) * point` (+ configurable safety buffer, default 2 points).
  [V] MQL5 measures a buy's SL/TP distance from **Bid** and a sell's from **Ask**, and states the limit as `distance >= level`.
  We use strict `<`/`>` plus the buffer, which is deliberately stricter. A stops level of 0 means "no minimum" [V]; the buffer still applies.
- `tickSize` = minimal price change (`SYMBOL_TRADE_TICK_SIZE`). Usually equals `point` on FX; can be larger on indices/metals.
  All prices are rounded to the nearest tick with `roundToTick` **before** validation, then to `digits`.
  Compare in integer points: `toPoints(p) = Math.round(p / point)`. All rule math is integer points; prices are only converted at the edges.
  (Rounding to tick is stricter than MQL5's examples, which normalise to digits only; it can never produce a price the server rejects for tick alignment.)
- R0.1 **No spec, no plan.** If the symbol spec (point, digits, stopsLevel, freezeLevel, volume limits) can't be loaded, refuse the plan with `BROKER_UNAVAILABLE`. Never fall back to `d = 0` or any default. (The v1 prototype did this; it is a bug.)
- R0.2 **Hedging accounts only for multi-position features.** On a netting account, N entries collapse into one position and every "batch" rule becomes meaningless. At connect, read the account's margin mode [T: confirm MetaApi field name]; if not hedging, disable entries/ladders and show why. Modify/close/trigger still work.

- R0.4 **No level at or below zero.** After rounding, every SL/TP must be > 0 points. On the MT5 wire 0 means "remove the level", so a
  price that rounds to 0 (tiny input, sub-tick input on an index, huge lock distance) would silently wipe or skip a stop. It is a plan error.
- R0.5 **Snapshot sanity.** For the requested symbol, each position needs a non-empty id, finite openPrice > 0, finite volume > 0, finite
  profit, SL/TP null or > 0, and a safe-integer magic ≥ 0 (orders likewise). Bad data → `BROKER_UNAVAILABLE`, except close-now (R4.7),
  which still closes by ticket, puts unknown-P/L positions first, and warns.
- R0.6 **Inputs must fit.** Prices must convert to safe-integer points on the symbol's grid; point offsets/distances are integers ≤ 1,000,000.
  Otherwise `VALIDATION`. The domain never throws on bad input; it returns a coded error.
- R0.3 **Unique tickets.** If a snapshot contains the same position id (or order id) twice, the broker data is corrupt: refuse the plan
  with `BROKER_UNAVAILABLE`. Exception, close-now (R4.7): de-duplicate and warn, because closing a ticket twice is harmless
  (the second returns "already closed") and a blocked panic button is not.

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
- R2.7 **Preserve:** the modify request always carries both levels: new value if set, else the position's current value, else "none" (domain: `null`; the broker adapter decides the wire format after the [T] test).
  [V] In a raw `MqlTradeRequest` an unset `sl`/`tp` is 0, and 0 means *remove the level*: that is the mechanism behind the wipe risk.
  [V] MQL5 lists both `sl` and `tp` as required fields for `TRADE_ACTION_SLTP`. [V] MetaApi marks both optional on `POSITION_MODIFY`
  and does **not** document what an omitted field does. So: always send both, and MockBroker must model the worst case
  (an omitted level gets wiped) so a missing field fails tests. [T] Confirm real omission behaviour on demo and record it in ADR-0002.
- R2.9 **Frozen position (skip).** [V] MQL5 forbids modifying a position whose SL or TP is within `freezeLevel` points of its activation
  price (buy: Bid, sell: Ask). The docs don't say whether that means the existing or the new level, so both are checked: new levels via `d`
  (R2.1 to R2.4), and any **existing** SL/TP within `freezeLevel × point` of ref (≤, inclusive) makes the item a skip with reason
  "frozen: TP 1.08650 is within the freeze level". Not a plan error: the position is about to close on its own. [T] confirm on demo.
- R2.11 **Preserved level inside d (warn).** Only levels that change are validated. If a preserved existing level sits inside `d` (but outside
  freeze), the plan warns that the broker may reject that item. [T] If the demo shows MT5 re-checks preserved levels, this becomes a skip.
- R2.10 **Item order** for modify plans: positions with no SL first (most exposed), then largest floating loss first, then id (deterministic).
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
  v1 mode is `raw` (exactly X on both sides). v1.1 adds an opt-in `spreadAligned` mode that
  shifts sell levels by the current spread so both sides trigger at roughly bid = X; it must show the shifted price and
  warn that spread changes after setting are not tracked.

## §4 Close now (R4.x)
- R4.1 Close by position id (`POSITION_CLOSE_ID`) at market; never a partial close in v1.
- R4.2 Kill switch does NOT block this.
- R4.3 Optional cancel pending orders of the same filter after positions.
- R4.4 Retry retryable failures per §6.
- R4.5 `TRADE_RETCODE_POSITION_CLOSED` (10036) or "position not found" → success, reported as "already closed".
- R4.6 Order: positions with the largest absolute floating loss first (most money at risk), then the rest (profit ascending, then id).
- R4.7 **Close now never depends on spec or quote.** It closes by ticket at market, so a missing or broken spec/quote must not block the
  panic button (R0.1 does not apply here). The plan still shows the quote when one is available.
- R4.8 Cancel-pending (R4.3) uses the same symbol, side (BUY_* orders are buys) and magic filter; `inProfitOnly` doesn't apply to orders.

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
- R6.5 **Entries with an unknown outcome are never retried blind (ADR-0009).** An entry whose result is `ambiguous` (our timeout,
  MetaApi timeout, unknown error, LOCKED, server-side not-connected) may have landed, or may still land: the SDK can send a request
  minutes later after reconnecting ("zombie"). Protocol:
  1. If the result carries `settled`, wait for it (bounded, default 60 s). Its outcome is the outcome.
  2. Then `reconcile(clientId)` with a bounded poll for stream lag (default 5 × 1 s): `position`/`order` → success with that ticket;
     `inFlight` → keep waiting (it may become a position); `notFound` after the poll → retry ONLY if `settled` resolved to a definite
     failure; if `settled` never resolved or resolved unknown → the item is "unknown, check manually". Never retried.
  3. Can't read the state → "unknown, check manually".
  Modifies and closes are safe to resend (same levels = no-op; closing a closed position returns 10036 or the book check says gone).
- R6.6 **Close-now never gives up early.** For `close`, REJECT, FROZEN, LOCKED, CLOSE_ORDER_EXIST, INVALID and ERROR are retryable
  (close by ticket is idempotent), and after ANY failed close the adapter checks the book: ticket gone = "already closed" (success).
  A partial close (DONE_PARTIAL) is retryable, not done.
- R6.7 **Partial entry fills.** DONE_PARTIAL on an entry is success, but the executor re-reads the position volume and reports the filled
  volume (Phase 04).

## §7 Drift guard
At execute time, re-read the quote. If any item's validity flipped since preview, abort the whole plan before the first broker call and return "price moved, re-preview". Configurable max drift in points (default: re-validate always).
- R7.1 **Untouched levels are re-read too.** Modify sends both levels (ADR-0008), so a level the owner changed elsewhere (e.g. moved the SL
  in the MT5 app) after the preview would be overwritten. Every modify item carries `before` (the levels the preview saw). At execute and
  before every retry, re-read the position; if EITHER level differs from `before`, the item is **skipped** ("changed elsewhere since the
  preview, re-preview"). Never sent. (Board review: checking only the untouched level missed a moved SL on a TP-only plan.)
- R7.2 **Quote age.** A quote older than `MAX_QUOTE_AGE_MS` (default 3 s while the market is open) is unusable for preview, drift guard
  and retry re-validation (R6.3): refuse with `PRICE_STALE` rather than validate against an old tick. Close-now is exempt (R4.7).

## §8 Break-even helpers (F5)
- R8.1 BE: `sl = openPrice + (isBuy ? +N : −N) * point`; must pass R2.1/R2.3; else skip with reason "not far enough in profit".
- R8.2 Lock: `sl = ref − N*point` (buy) / `ref + N*point` (sell); only in-profit positions (others skipped "not in profit").
  If N doesn't clear §2 the plan is invalid (R2.6): it fails the same way for every position on that side, so it's a parameter error, not a per-position skip.
- R8.3 Neither helper may move an existing SL to a worse level (further from price). If it would, skip with "SL already better".
- R8.6 **Lock never locks a loss.** After rounding, a lock SL must be at or past the entry (buy `sl ≥ open`, sell `sl ≤ open`), else skip
  "not enough profit to lock". (`profit > 0` alone can include swaps; this is the geometric check the name promises.)
- R8.4 **Tick rounding never gives less than asked.** Break-even rounds toward profit (buy up, sell down), so it locks at least BE + N.
  Lock rounds away from price (buy down, sell up), so the stop is at least N points away. Only matters when tickSize > point.
- R8.5 Parameters: break-even offset N is an integer ≥ 0 (0 = exact entry price); lock distance N is an integer ≥ 1. Both exclude swaps and commission.

## §9 Order Desk (batch identity, risk, guards)
Field names below were verified 2026-11-25 from `metaapi.cloud-sdk@29.3.4` (see 09-PERFORMANCE "MetaApi SDK contract"). [T] = confirm on the Exness demo.
- R9.1 **Batch identity (ADR-0005).** Every order from a batch carries:
  - `magic = APP_MAGIC_PREFIX × 10^9 + batchSeq` (batchSeq < 10^9; result stays below 2^53 so JS numbers are exact). App-owned = `floor(magic / 10^9) === APP_MAGIC_PREFIX`.
    `batchSeq` comes from a database sequence: atomic, never reused, allocated when the plan is stored (so a batch keeps its id even if it's retried).
    [T] MetaApi accepts `magic` in `TradeOptions` on market and pending orders and returns `magic` on positions and orders.
  - `comment = "OD:" + base36(batchSeq)` (≤ 9 chars; human-readable only, never used to match).
  - `clientId = <planShort><index>`: `planShort` = first 6 hex chars of the plan id, `index` = the item's zero-based index, decimal, 3 digits (R6.5 reconciliation key; the cap of 500 orders per action fits).
  - [V] `comment` + `clientId` together ≤ 26 characters (`TradeOptions`). With the formats above the maximum is 9 + 9 = 18. The plan builder asserts it for every item and refuses the plan otherwise, with a test.
  - Matching is always on `magic`. Comments can be truncated or rewritten by the broker; magic is a number set once at entry.
- R9.2 **Risk to SL.** Per order = |entry − SL| ÷ `tickSize` × `lossTickValue` × lots, in account currency.
  - [V] `lossTickValue` (and `profitTickValue`) live on the **price** feed (`MetatraderSymbolPrice`), not on the symbol specification; `Quote` carries `lossTickValue` for this.
    It is the value of one tick of loss for one lot in account currency, as the broker computes it.
  - `entry` is the expected fill (buy: ask, sell: bid; pending: its own level). Money is rounded to cents.
  - If `lossTickValue` is missing, not finite or ≤ 0, risk can't be verified: **block** ("can't verify risk"), never guess.
  - Total risk = Σ per order. **R9.2a (cap):** total risk ≤ `MAX_RISK_PCT_PER_ACTION`% of account **equity** at preview. Over → reject, showing both numbers.
  - **R9.2b (no stop):** a batch must have an SL unless the owner explicitly chose "no stop" (`noStop: true`). With `noStop`, risk is shown as **unlimited**, the cap in R9.2a is skipped (R5.2's lot and count caps still apply), and the preview carries an amber warning. An SL that was requested is never dropped (R5.3).
- R9.3 **Margin check** uses the broker's own number: `calculateMargin({ symbol, type, volume, openPrice })` → `{ margin?: number }`, `margin` undefined when the broker can't compute it.
  - Market batch: one call with the **total** volume at the expected fill (identical entries, so margin adds up exactly).
  - Ladder: one call per level, at most 10 distinct (volume, price) calls. Beyond 10, take the highest margin-per-lot among the 10 and multiply by total lots: a conservative **upper bound**, labelled as such in the preview.
    Hedged offsets can only lower the broker's real figure, so this never under-states the need.
  - Required margin > `freeMargin` → **block**. Required margin undefined or a failed call → **block** ("can't verify margin"). No estimate, no override on live.
  - **Warn** (amber, don't block) if `equity ÷ (margin + required)` would fall below 300%.
  - [T] Credit cost of `calculateMargin` isn't in the published table: measure it on demo. Until then the call count is capped as above, and previews are never fired in a loop.
- R9.4 **Spread guard** compares (ask − bid) in points at **execute** time, not preview time. Two checks; either one refuses the whole batch with zero broker calls:
  - R9.4a **Absolute:** spread > `SPREAD_MAX_POINTS` (per symbol, optional, off by default).
  - R9.4b **Adaptive (on by default):** spread > `SPREAD_GUARD_K` (default 3) × the **median** spread over the last `SPREAD_WINDOW_SEC` (default 300). It works on any symbol without per-symbol tuning and catches news spikes.
    Samples: the server records `ask − bid` once a second per symbol the owner has opened in the last 10 minutes, from the zero-credit terminal state. Fewer than 30 samples in the window → fall back to R9.4a; if that is off too, **warn** in the preview, don't block.
  - The preview shows "spread now X pts, normal Y pts". Entries only: closes and modifies are never refused by the spread guard.
- R9.5 **Scaled ladder lots:** flat = same; increasing / decreasing = linear from `lotStart` to `lotEnd` across the levels, each rounded **down** to `volumeStep` and kept ≥ `volumeMin` (a level that would round below the minimum is **not** bumped up: the plan is refused, naming the level). Total lots shown in the preview and checked against R5.2.
- R9.6 **Presets** store recipes, never prices relative to a stale quote. Firing always builds a fresh plan from the live quote and spec through the same path as a manual action (preview → confirm → execute). An absolute-price preset is flagged as such and its prices are re-validated (R5.5) against the live market.
- R9.7 **One path.** Market batches, ladders and presets all produce a normal stored plan (same hash, 30 s expiry, drift guard, idempotent claim). The only new thing at execute is the spread guard (R9.4) and a re-read of free margin (R9.3 vs the stored requirement: if free margin fell below it, refuse). Nothing about entries bypasses §6 or ADR-0009.
- R9.8 **Entries are not retried blind.** A timed-out entry is reconciled by `clientId` before any retry (R6.5). The batch summary counts *filled*, *failed*, *unknown* separately; a partial batch says so in plain words and offers "retry failed" only for items confirmed absent.
- R9.9 **Batch management (OD5)** acts on `magic` decoded to `batchSeq` (R1.1): move SL/TP (§2), break-even/lock (§8), close, cancel the remaining pending orders. It selects positions and pending orders with that magic and only those; manual trades (magic 0) and other EAs are never matched.

