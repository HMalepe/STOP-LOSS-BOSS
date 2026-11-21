const { authed, getPositions, getOrders, getPrice, DEMO } = require('../lib/mt');

module.exports = async (req, res) => {
  if (!authed(req, res)) return;
  try {
    const [positions, orders] = await Promise.all([getPositions(), getOrders().catch(() => [])]);
    const prices = {};
    for (const s of new Set(positions.map((p) => p.symbol))) {
      try { prices[s] = await getPrice(s); } catch { /* skip */ }
    }
    res.status(200).json({ demo: DEMO, positions, orders, prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
