const crypto = require('crypto');

const DEMO = process.env.DEMO === '1';
const REGION = process.env.METAAPI_REGION || 'new-york';
const BASE = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai/users/current/accounts/${process.env.METAAPI_ACCOUNT_ID}`;
const BATCH = 5; // concurrent trade calls per wave (rate-limit friendly)
const OK_CODES = new Set([10008, 10009, 10010]); // PLACED, DONE, DONE_PARTIAL

const isBuy = (p) => p.type === 'POSITION_TYPE_BUY';

function authed(req, res) {
  const key = Buffer.from(String(req.headers['x-app-key'] || ''));
  const pw = Buffer.from(String(process.env.APP_PASSWORD || ''));
  if (!pw.length || key.length !== pw.length || !crypto.timingSafeEqual(key, pw)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function mt(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'auth-token': process.env.METAAPI_TOKEN, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { message: text }; }
  if (!r.ok) throw new Error(json.message || `HTTP ${r.status}`);
  return json;
}

async function trade(body) {
  const r = await mt('/trade', { method: 'POST', body: JSON.stringify(body) });
  return { ok: OK_CODES.has(r.numericCode) || r.stringCode === 'TRADE_RETCODE_DONE', message: r.message || r.stringCode || '' };
}

// ---------- demo mode (in-memory, resets on cold start) ----------
const DEMO_PRICE = { bid: 1.0861, ask: 1.0862 };
function demo() {
  if (!global.__demo) {
    global.__demo = {
      positions: Array.from({ length: 52 }, (_, i) => ({
        id: String(1000 + i),
        symbol: 'EURUSD',
        type: i % 4 === 0 ? 'POSITION_TYPE_SELL' : 'POSITION_TYPE_BUY',
        volume: 0.1,
        openPrice: +(1.085 + (i % 7) * 0.0003).toFixed(5),
        profit: +(Math.sin(i) * 20).toFixed(2),
      })),
      orders: [
        { id: '9001', symbol: 'EURUSD', type: 'ORDER_TYPE_BUY_LIMIT', openPrice: 1.082 },
        { id: '9002', symbol: 'EURUSD', type: 'ORDER_TYPE_SELL_LIMIT', openPrice: 1.09 },
      ],
    };
  }
  return global.__demo;
}

// ---------- data ----------
const getPositions = async () => (DEMO ? demo().positions : mt('/positions'));
const getOrders = async () => (DEMO ? demo().orders : mt('/orders'));
const getPrice = async (s) => (DEMO ? DEMO_PRICE : mt(`/symbols/${encodeURIComponent(s)}/current-price`));

async function minStopDistance(symbol) {
  if (DEMO) return 0.0005;
  try {
    const s = await mt(`/symbols/${encodeURIComponent(symbol)}/specification`);
    return (s.stopsLevel || 0) * (s.point || s.tickSize || 0);
  } catch { return 0; }
}

// ---------- rules ----------
// A buy closes at the bid, a sell closes at the ask.
// Buy:  SL < bid - d,  TP > bid + d.   Sell: SL > ask + d,  TP < ask - d.
function checkLevels(pos, sl, tp, price, d) {
  const ref = isBuy(pos) ? price.bid : price.ask;
  const side = isBuy(pos) ? 'Buy' : 'Sell';
  const f = (n) => n.toFixed(5);
  if (sl != null) {
    if (isBuy(pos) && !(sl < ref - d)) return `${side} SL must be below ${f(ref - d)}`;
    if (!isBuy(pos) && !(sl > ref + d)) return `${side} SL must be above ${f(ref + d)}`;
  }
  if (tp != null) {
    if (isBuy(pos) && !(tp > ref + d)) return `${side} TP must be above ${f(ref + d)}`;
    if (!isBuy(pos) && !(tp < ref - d)) return `${side} TP must be below ${f(ref - d)}`;
  }
  return null;
}

// "Close everything when price hits X": for each position, X becomes its SL or TP,
// whichever side of price X is on. Held by the broker, so it fires with the app closed.
function closeAtLevels(pos, x, price, d) {
  const ref = isBuy(pos) ? price.bid : price.ask;
  if (Math.abs(x - ref) <= d) return { error: `Too close to price (${ref}). Use Close all now.` };
  const above = x > ref;
  // buy: above = profit (TP), below = loss (SL). sell: the reverse.
  const asTP = isBuy(pos) ? above : !above;
  return asTP ? { tp: x } : { sl: x };
}

// ---------- actions ----------
async function modifyPosition(pos, { sl, tp }) {
  // Always send both so MT doesn't wipe the one we aren't changing.
  const stopLoss = sl ?? pos.stopLoss;
  const takeProfit = tp ?? pos.takeProfit;
  if (DEMO) {
    const p = demo().positions.find((x) => x.id === pos.id);
    p.stopLoss = stopLoss; p.takeProfit = takeProfit;
    return { ok: true, message: 'demo ok' };
  }
  const body = { actionType: 'POSITION_MODIFY', positionId: pos.id };
  if (stopLoss) body.stopLoss = stopLoss;
  if (takeProfit) body.takeProfit = takeProfit;
  return trade(body);
}

async function closePosition(pos) {
  if (DEMO) {
    const d = demo();
    d.positions = d.positions.filter((x) => x.id !== pos.id);
    return { ok: true, message: 'demo closed' };
  }
  return trade({ actionType: 'POSITION_CLOSE_ID', positionId: pos.id });
}

async function cancelOrder(order) {
  if (DEMO) {
    const d = demo();
    d.orders = d.orders.filter((x) => x.id !== order.id);
    return { ok: true, message: 'demo cancelled' };
  }
  return trade({ actionType: 'ORDER_CANCEL', orderId: order.id });
}

// Run fn over items in waves of BATCH, collect per-item results.
async function inWaves(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const wave = items.slice(i, i + BATCH);
    const settled = await Promise.allSettled(wave.map(fn));
    settled.forEach((r, j) => out.push({
      id: wave[j].id,
      ok: r.status === 'fulfilled' && r.value.ok,
      message: r.status === 'fulfilled' ? r.value.message : (r.reason?.message || 'failed'),
    }));
  }
  return out;
}

const summary = (results) => ({
  total: results.length,
  succeeded: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
});

module.exports = {
  DEMO, isBuy, authed, getPositions, getOrders, getPrice, minStopDistance,
  checkLevels, closeAtLevels, modifyPosition, closePosition, cancelOrder, inWaves, summary,
};
