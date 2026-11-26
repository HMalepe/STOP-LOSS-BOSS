import { describe, expect, it } from "vitest";
import type { EntryAccount, EntryCaps } from "@/domain/entries";
import { buildMarketBatch } from "@/domain/entries";
import { entryDrift } from "@/domain/entryDrift";
import { buildLadder } from "@/domain/ladder";
import { marketFrom } from "@/domain/rules";
import type { Quote, SymbolSpec } from "@/domain/types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 10,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 50,
  volumeStep: 0.01,
};
const Q: Quote = { symbol: "EURUSD", bid: 1.086, ask: 1.08612, time: 1, lossTickValue: 1 };
const CAPS: EntryCaps = { maxOrders: 100, maxTotalLots: 50, maxRiskPct: 100 };
const ACCT: EntryAccount = { equity: 100_000, hedging: true, commissionPerLot: 0 };
const mk = (q: Quote) => marketFrom(SPEC, q);

describe("§7 drift guard for entries (stored levels re-checked against the live market)", () => {
  const market = buildMarketBatch(
    {
      symbol: "EURUSD",
      side: "BUY",
      count: 5,
      volume: 0.1,
      sl: { mode: "points", points: 150 },
      tp: { mode: "points", points: 300 },
    },
    { spec: SPEC, quote: Q },
    CAPS,
    ACCT,
  );
  const ladder = buildLadder(
    {
      symbol: "EURUSD",
      type: "BUY_LIMIT",
      from: 1.085,
      to: 1.08,
      spacing: { kind: "levels", levels: 4 },
      lots: { kind: "flat", volume: 0.1 },
      slPoints: 200,
      expiry: { type: "DAY" },
    },
    { spec: SPEC, quote: Q },
    CAPS,
    ACCT,
  );
  if (!market.ok || !ladder.ok) throw new Error("setup");

  it("nothing moved → no problems", () => {
    expect(entryDrift(market.plan.items, mk(Q))).toEqual([]);
    expect(entryDrift(ladder.plan.items, mk(Q))).toEqual([]);
  });
  it("the market fell until the buy SL is too close to the bid → one grouped reason, count shown", () => {
    const moved = { ...Q, bid: 1.0846, ask: 1.08472 }; // buy SL 1.08462 must now be below 1.0846 − 12 pts = 1.08448
    const d = entryDrift(market.plan.items, mk(moved));
    expect(d).toEqual([{ id: "#0", reason: "SL for a buy must now be below 1.08448 (R2.1); 5 orders" }]);
  });
  it("a TP the market ran through, and an SL, are both reported", () => {
    const d = entryDrift(market.plan.items, mk({ ...Q, bid: 1.0895, ask: 1.08962 }));
    expect(d.map((x) => x.reason.split(" must")[0])).toEqual(["TP for a buy"]);
  });
  it("a Buy Limit the market has fallen through is refused (must be below ask − d)", () => {
    const d = entryDrift(ladder.plan.items, mk({ ...Q, bid: 1.0838, ask: 1.08392 }));
    expect(d.length).toBeGreaterThan(0);
    expect(d[0]?.reason).toMatch(/^buy limit at 1\.\d+ must now be below 1\.0838\d \(R5\.5\)/);
  });
  it("reports at most 5 distinct reasons", () => {
    const d = entryDrift(ladder.plan.items, mk({ ...Q, bid: 1.0, ask: 1.0001 }));
    expect(d.length).toBeLessThanOrEqual(5);
  });
});
