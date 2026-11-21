# SL Batch

Phone-first web app: set the same stop loss on all open positions of one symbol, without opening MetaTrader.

Stack: static page + 2 Vercel serverless functions + MetaApi (cloud bridge to your MT4/MT5 account). No npm dependencies.

## 1. Try it in demo mode (no broker, no risk)

Set `DEMO=1` and `APP_PASSWORD=<anything>` in Vercel env vars, deploy, open the URL on your phone.
You get 52 fake EURUSD positions (a mix of buys and sells) to play with.

## 2. Go live

1. Create a MetaApi account (metaapi.cloud) and add your Exness MT5 account (login, password, server name).
   Start with a DEMO Exness account.
2. Env vars in Vercel:
   - `APP_PASSWORD`: long random string, this is your app login
   - `METAAPI_TOKEN`: from MetaApi dashboard
   - `METAAPI_ACCOUNT_ID`: the account id MetaApi gives you
   - `METAAPI_REGION`: usually `new-york` (check your account's region)
   - remove `DEMO`
3. Deploy: `vercel --prod` from this folder.
4. On your phone: open the URL, "Add to Home Screen".

## Features

1. **Close all at price**: type one price. Each position gets it as its TP or SL, whichever side of price it sits on
   (buys above price = TP, below = SL; sells the reverse). The broker holds these orders, so they fire with the app closed.
2. **Set SL / TP on all**: either or both. Whatever you leave blank stays as it was.
3. **Close all now**: market-closes every position (selected symbol or all symbols), optionally cancels pending orders.
   Tap once to arm, tap again within 4 seconds to fire.

Every action previews first, runs 5 at a time (rate limits), and shows a per-position result table.

## Know this

- The trigger only covers positions open when you set it. New trades opened afterwards need it set again.
- A trigger hit as stop loss fills at market and can slip on gaps or news; take profits fill at the price or better.
- A trigger too close to the current price (inside the broker's stop level) is refused. Use Close all now instead.
- Setting a new trigger overwrites that side's existing SL or TP.

## Security notes

- Credentials live only in Vercel env vars. The phone only knows `APP_PASSWORD`.
- Anyone with `APP_PASSWORD` can modify your stops. Use a long one. Next upgrade: real login with 2FA.
- SLs are server-side orders at the broker, so they keep working if this app is down.
