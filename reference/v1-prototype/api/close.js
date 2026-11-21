// POST /api/close  { symbol?: string|"ALL", cancelPending?: boolean, confirm: "CLOSE" }
// Market-closes every open position (optionally one symbol) and can cancel pending orders.
const m = require('../lib/mt');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!m.authed(req, res)) return;

  try {
    const { symbol = 'ALL', cancelPending = false, confirm } = req.body || {};
    if (confirm !== 'CLOSE') return res.status(400).json({ error: 'Missing confirmation.' });

    const match = (x) => symbol === 'ALL' || x.symbol === symbol;
    const positions = (await m.getPositions()).filter(match);
    const orders = cancelPending ? (await m.getOrders()).filter(match) : [];
    if (!positions.length && !orders.length) return res.status(400).json({ error: 'Nothing to close.' });

    const closed = await m.inWaves(positions, m.closePosition);
    const cancelled = await m.inWaves(orders, m.cancelOrder);

    res.status(200).json({
      demo: m.DEMO,
      positions: m.summary(closed),
      orders: m.summary(cancelled),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
