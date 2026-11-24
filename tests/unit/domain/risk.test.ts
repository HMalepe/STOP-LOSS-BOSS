import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildLadder, buildMarketBatch } from "@/domain/entries";
import { riskToStop } from "@/domain/risk";
import { EURUSD, XAUUSD, quote } from "./fixtures";

const ID = { magic: 7_731_000_000_001, batchShort: "a", planShort: "a" };
const CAPS = { maxOrdersPerAction: 100, maxTotalLots: 50 };
const Q = quote(1.086, 1.0861);

const market = (
  over: { volume?: number; sl?: number | undefined; count?: number; side?: "BUY" | "SELL" } = {},
) => {
  const r = buildMarketBatch(
    {
      symbol: "EURUSD",
      side: over.side ?? "BUY",
      count: over.count ?? 2,
      volume: over.volume ?? 0.1,
      stopLoss: over.sl === undefined ? undefined : { kind: "points", value: over.sl },
    },
    { spec: EURUSD, quote: Q },
    ID,
    CAPS,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.plan.items;
};

describe("R9.2 money at risk to SL = |entry − SL| / tickSize × tickValue × lots", () => {
  it("market buy: entry is the expected fill (ask); 150 pts × $1/pt-lot × 0.1 lot = $15 each", () => {
    // EURUSD tick 0.00001; tick value $1 per 1.0 lot → 150 pts × 1 × 0.1 = 15.
    const r = riskToStop(market({ sl: 150 }), EURUSD, { ...Q, lossTickValue: 1 });
    expect(r).toEqual({ ok: true, perOrder: [15, 15], total: 30, unbounded: false });
  });

  it("sell: entry is the bid", () => {
    const r = riskToStop(market({ sl: 200, side: "SELL", count: 1 }), EURUSD, { ...Q, lossTickValue: 1 });
    expect(r).toMatchObject({ total: 20 });
  });

  it("pending: entry is the order's own price; scaled lots per level", () => {
    const l = buildLadder(
      {
        symbol: "EURUSD",
        side: "BUY",
        kind: "limit",
        from: 1.085,
        to: 1.084,
        spacing: { mode: "count", levels: 2 },
        lots: { mode: "scaled", start: 0.1, end: 0.3 },
        slOffsetPoints: 100,
      },
      { spec: EURUSD, quote: Q },
      ID,
      CAPS,
    );
    if (!l.ok) throw new Error(l.error.message);
    expect(riskToStop(l.plan.items, EURUSD, { ...Q, lossTickValue: 1 })).toEqual({
      ok: true,
      perOrder: [10, 30],
      total: 40,
      unbounded: false,
    });
  });

  it("gold: tickSize 0.01, tick value $1 per lot → a $5 stop on 0.1 lot risks $50", () => {
    const g = quote(2650, 2650.3, "XAUUSD");
    const r = buildMarketBatch(
      { symbol: "XAUUSD", side: "BUY", count: 1, volume: 0.1, stopLoss: { kind: "price", value: 2645.3 } },
      { spec: XAUUSD, quote: g },
      ID,
      CAPS,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(riskToStop(r.plan.items, XAUUSD, { ...g, lossTickValue: 1 })).toMatchObject({ total: 50 });
  });

  it("no SL on any order → unbounded (never a number)", () => {
    const r = riskToStop(market({ sl: undefined }), EURUSD, { ...Q, lossTickValue: 1 });
    expect(r).toEqual({ ok: true, perOrder: [null, null], total: null, unbounded: true });
  });

  it("no usable tick value → refuse, never guess (R9.2)", () => {
    for (const lossTickValue of [undefined, 0, -1, Number.NaN]) {
      expect(
        riskToStop(market({ sl: 150 }), EURUSD, {
          ...Q,
          ...(lossTickValue === undefined ? {} : { lossTickValue }),
        }).ok,
      ).toBe(false);
    }
  });

  it("property: total = sum of per-order risks, every risk ≥ 0, and scales linearly with lots", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 5_000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 10 }),
        (sl, lotSteps, count) => {
          const items = market({ sl, volume: lotSteps / 100, count });
          const r = riskToStop(items, EURUSD, { ...Q, lossTickValue: 1 });
          if (!r.ok || r.total === null) throw new Error("expected bounded");
          expect(r.perOrder.every((x) => x !== null && x >= 0)).toBe(true);
          expect(r.total).toBeCloseTo(
            r.perOrder.reduce<number>((a, b) => a + (b ?? 0), 0),
            2,
          );
          expect(r.total).toBeCloseTo((sl * lotSteps * count) / 100, 2);
        },
      ),
    );
  });
});
