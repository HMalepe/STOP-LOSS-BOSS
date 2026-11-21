// POST /api/apply
// mode "levels":  { symbol, side, stopLoss?, takeProfit?, dryRun? }  same SL and/or TP on all
// mode "closeAt": { symbol, side, price, dryRun? }  close everything when price hits `price`
const m = require('../lib/mt');

const num = (v) => (v === '' || v == null ? null : Number(v));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!m.authed(req, res)) return;

  try {
    const { mode = 'levels', symbol, side = 'ALL', dryRun } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'Pick a symbol.' });

    let positions = (await m.getPositions()).filter((p) => p.symbol === symbol);
    if (side === 'BUY') positions = positions.filter(m.isBuy);
    if (side === 'SELL') positions = positions.filter((p) => !m.isBuy(p));
    if (!positions.length) return res.status(400).json({ error: 'No matching open positions.' });

    const price = await m.getPrice(symbol);
    const d = await m.minStopDistance(symbol);

    // Build a plan: what each position gets.
    const plan = [];
    const errors = new Set();

    if (mode === 'closeAt') {
      const x = num(req.body.price);
      if (!(x > 0)) return res.status(400).json({ error: 'Enter a valid trigger price.' });
      for (const p of positions) {
        const lv = m.closeAtLevels(p, x, price, d);
        if (lv.error) errors.add(lv.error); else plan.push({ pos: p, ...lv });
      }
    } else {
      const sl = num(req.body.stopLoss);
      const tp = num(req.body.takeProfit);
      if (sl == null && tp == null) return res.status(400).json({ error: 'Enter an SL, a TP, or both.' });
      if ((sl != null && !(sl > 0)) || (tp != null && !(tp > 0))) return res.status(400).json({ error: 'Prices must be positive numbers.' });
      for (const p of positions) {
        const err = m.checkLevels(p, sl, tp, price, d);
        if (err) errors.add(err); else plan.push({ pos: p, sl, tp });
      }
    }

    if (errors.size) {
      return res.status(400).json({
        error: [...errors].join(' · ') + ` (bid ${price.bid} / ask ${price.ask})`,
      });
    }

    const buys = plan.filter((x) => m.isBuy(x.pos)).length;
    const preview = {
      demo: m.DEMO, mode, symbol, price,
      count: plan.length, buys, sells: plan.length - buys,
      asSL: plan.filter((x) => x.sl != null).length,
      asTP: plan.filter((x) => x.tp != null).length,
    };
    if (dryRun) return res.status(200).json({ dryRun: true, ...preview });

    const results = await m.inWaves(plan, (x) => m.modifyPosition(x.pos, { sl: x.sl, tp: x.tp }));
    // inWaves keys results by item.id; plan items carry pos, so map ids back.
    results.forEach((r, i) => { r.id = plan[i].pos.id; });
    res.status(200).json({ ...preview, ...m.summary(results) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
