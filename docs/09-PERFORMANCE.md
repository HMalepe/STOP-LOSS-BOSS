# 09: Performance (the scalping requirement)

## The two latencies (explain these to the owner in the UI help)
1. **Trigger latency:** once SL/TP is set, the broker server executes it. Our app adds zero latency there.
2. **Apply latency:** time to push N modifications. This is our problem: N × per-call time ÷ concurrency, bounded by rate limits.
So the app's job is to make (2) as small as the broker and MetaApi allow, and to teach the user to set triggers early.

## Levers, in order of impact
1. **Warm streaming connection** (MetaApi SDK streaming/RPC connection kept open in the worker) instead of cold REST calls per request. Removes connection setup and cold starts.
2. **Concurrency tuned to the real rate limit.** Token-bucket limiter in `src/execution/rateLimiter.ts`. Start conservative; make rate and burst configurable; measure.
3. **Region co-location:** worker region ≈ MetaApi region ≈ broker server region.
4. **No-op skipping** (R2.8): don't send modifies that change nothing.
5. **Pre-flight in parallel:** fetch positions + quote + spec concurrently; cache spec per symbol (TTL 1h).
6. **Prioritise:** for close-at and SL changes, process positions closest to the trigger first (most at risk).
7. **Streaming progress** so the user sees it working; don't wait for all before showing anything.

## Verified facts and open measurements (never invent numbers)
Checked 2026-11-21 against the official pages listed under Sources. "Measure" rows get filled in Phase 3 on an Exness demo.

| Item | Value | Source / how measured |
|---|---|---|
| MetaApi per-account credit limit | **5,000 credits / 10 s** | [rateLimiting][rl] |
| MetaApi per-application limit | 1,000 credits/s, 6,000/min, 18,000/h, 43,200/6h, each × deployed accounts | [rateLimiting][rl] |
| Cost of one trade request (REST or websocket) | **10 credits** | [rateLimiting][rl] |
| Cost of streaming terminal-state updates | **0 credits** | [rateLimiting][rl] |
| Derived trade ceiling, 1 account | ~500 trades per 10 s (avg ≈ 50/s), if nothing else spends credits | arithmetic from the rows above |
| Max concurrent in-flight trade requests | not stated by MetaApi | measure |
| Throttle response | HTTP 429 `TooManyRequestsError`, `metadata.recommendedRetryTime` (ISO) + `exceededPeriod`; MT5 code 10024 | [rateLimiting][rl], [MT5 codes][rc] |
| MetaApi success codes | numeric 0, 10008, 10009, 10010, 10025 | [tradeResponse][tr] |
| `comment` + `clientId` length | ≤ 26 characters combined | [trade model][tm] |
| POSITION_MODIFY with one level omitted | **not documented**; treat as unsafe, always send both (R2.7) | [trade model][tm], [MqlTradeRequest][mq] |
| Typical trade latency (streaming / REST) | ? | measure: p50/p95 over 200 modifies on demo |
| Exness stops/freeze level for target symbol | ? | read from symbol spec on demo |
| Broker max open positions / pending orders | ? | Exness account docs + LIMIT_ORDERS (10033) test |
| Account margin mode (hedging?) | ? | read at connect (R0.2) |

## What the limits mean (design consequences)
1. **1,000 positions can't be done in a few seconds.** At 10 credits a trade, one account's pool covers ~500 trades per 10 s.
   Closing 1,000 positions is rate-limit bound at roughly 10 to 20 s however good the code is. 100 positions fits easily inside
   the 5 s target. The UI must show that honestly (progress bar plus ETA), and R4.6 makes sure the worst losers close first.
2. **Never spend credits on reads during a batch.** Positions, quotes and specs come from the **streaming connection** (0 credits),
   so the whole credit budget goes to trades. This makes ADR-0003's warm worker a correctness and speed issue, not a nice-to-have:
   polling REST for positions during a 1,000-item close would eat the trade budget. See ADR-0007.
3. **The limiter is credit-based, not request-based.** `rateLimiter.ts` models a token bucket in credits (capacity 5,000 per 10 s,
   minus a 10% safety margin), with per-call cost from a table. A 429 drains the bucket and pauses it until `recommendedRetryTime` (R6.2).

[rl]: https://metaapi.cloud/docs/client/rateLimiting/
[tm]: https://metaapi.cloud/docs/client/models/metatraderTrade/
[tr]: https://metaapi.cloud/docs/client/models/metatraderTradeResponse/
[mq]: https://www.mql5.com/en/docs/constants/structures/mqltraderequest
[rc]: https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes

Note: the MetaApi rate-limit page has an internal inconsistency (one 429 example's message says 2,000 credits while its metadata says 5,000). Re-check before Phase 4 and trust measured 429s over the doc.

## Budgets (targets; revise after measurement)
- Preview: p95 < 800ms for 1,000 positions.
- Execute 100 modifies: p95 < 5s. 1,000: expect ~10 to 20 s (credit-bound, see above); aim to be rate-limit-bound, not code-bound.
- UI interaction to visual feedback: < 100ms.

## Load test
`pnpm load` runs 1,000 positions on MockBroker configured with the verified limits and prints: total time, p50/p95 per call, retries, max concurrency observed, duplicates (must be 0).

## MetaApi SDK contract (verified 2026-11-22 from `metaapi.cloud-sdk@29.3.4` type definitions and source)
Read directly from the published package (`dist/**/*.d.ts` and the JS it ships), not from memory or blog posts.

| Item | Verified value | Where |
|---|---|---|
| Package / version | `metaapi.cloud-sdk` 29.3.4 (latest) | npm registry |
| Connect | `new MetaApi(token, { region, requestTimeout, retryOpts })` → `metatraderAccountApi.getAccount(id)` → `account.getStreamingConnection()` → `connect()` → `waitSynchronized()` | `metaApi.d.ts`, `metatraderAccount.d.ts` |
| Zero-credit reads | `connection.terminalState`: `positions`, `orders`, `specification(symbol)`, `price(symbol)`, `accountInformation`, `connected`, `connectedToBroker` | `terminalState.d.ts` |
| Health | `connection.healthMonitor.healthStatus`, `.uptime` | `connectionHealthMonitor.d.ts` |
| Modify | `modifyPosition(positionId, stopLoss?, takeProfit?)`. **An omitted level is omitted from the wire request** (`_generateStopOptions` only sets fields that are numbers). `0` is sent as `0` | `metaApiConnectionInstance.js` |
| Close / cancel | `closePosition(positionId, options)`, `cancelOrder(orderId)` | same |
| Entries | `createMarketBuyOrder / createMarketSellOrder(symbol, volume, sl?, tp?, options)`, `createLimit/StopBuy/SellOrder(symbol, volume, openPrice, sl?, tp?, options)` | same |
| Order options | `comment`, `clientId` (comment + clientId ≤ 26 chars), `magic` (number; else account default), `slippage` (points) | `TradeOptions` in `metaApiConnectionInstance.d.ts` |
| Success | stringCode ∈ {ERR_NO_ERROR, TRADE_RETCODE_PLACED, _DONE, _DONE_PARTIAL, _NO_CHANGES}; numeric 0, 10008–10010, 10025 | `metaApiWebsocket.client.js` `trade()` |
| Failure | throws `TradeError { message, numericCode, stringCode }` | `tradeError.d.ts` |
| SDK retries on **trade** | **None.** `rpcRequest` sends `trade` once (`_makeRequest`), no retry loop | `metaApiWebsocket.client.js` `rpcRequest` |
| SDK retries on reads | Up to `retryOpts.retries` (default 5) on TooManyRequests (waits for `recommendedRetryTime`), Timeout, NotSynchronized, Internal; backoff up to 30 s | same |
| Request timeout | Default **60 s** (`requestTimeout`) | `metaApiWebsocket.client.js` constructor |
| High-reliability accounts | Trade is sent to 2 instances with one random 32-char `requestId` (server-side de-dup) | `rpcRequestAllInstances` |
| Position fields | `id: number`, `type: POSITION_TYPE_BUY/SELL`, `symbol`, `magic`, `openPrice`, `currentPrice`, `currentTickValue`, `stopLoss?`, `takeProfit?`, `volume`, `profit`, `swap`, `commission`, `comment?`, `clientId?` | `metaApiWebsocket.client.schemas.d.ts` |
| Order fields | `id: number`, `type: ORDER_TYPE_BUY_LIMIT/…`, `state`, `symbol`, `magic`, `openPrice`, `stopLoss?`, `takeProfit?`, `volume`, `currentVolume`, `clientId?` | same |
| Spec fields | `symbol`, `digits`, `point`, `tickSize`, `stopsLevel`, `freezeLevel`, `minVolume`, `maxVolume`, `volumeStep`, `contractSize`, `tradeMode?` | same |
| Price fields | `symbol`, `bid`, `ask`, `profitTickValue`, `lossTickValue`, `time: Date` | same |
| Account | `marginMode` ∈ {ACCOUNT_MARGIN_MODE_RETAIL_HEDGING, _RETAIL_NETTING, _EXCHANGE}, `balance`, `equity`, `margin`, `freeMargin`, `marginLevel`, `tradeAllowed`, `currency`, `leverage` | same |
| Margin calc | `calculateMargin(order)` exists (R9.3 can use the broker's number) | `metaApiConnectionInstance.d.ts` |

### Consequences (ADR-0008)
1. The adapter **always sends both levels as explicit numbers**: the level to keep, or `0` for "none". The undocumented "omitted field" path is never used.
2. Our executor wraps every trade in its **own** timeout (default 60 s is far too long for a scalper) and treats a timeout on an entry as ambiguous (R6.5).
3. Reads during a batch come from `terminalState` (0 credits, no SDK retry stalls). RPC reads are a fallback only.
4. MetaApi ids are numbers in the SDK types and strings in trade calls; the adapter normalises every id to a string.
5. R0.2 reads `accountInformation.marginMode`; anything other than RETAIL_HEDGING disables batch entries.
