import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildLadder, type BatchIdentity, type LadderRequest } from "@/domain/entries";
import { toPoints } from "@/domain/price";
import { EURUSD, US30, quote } from "./fixtures";

const ID: BatchIdentity = { magic: 7_731_000_000_043, batchShort: "L1", planShort: "q9" };
const CAPS = { maxOrdersPerAction: 100, maxTotalLots: 5 };
const Q = quote(1.086, 1.0861);
const snap = { spec: EURUSD, quote: Q };
// A buy-limit ladder from 1.0850 down to 1.0800 in 6 levels: every 100 points.
const req = (over: Partial<LadderRequest> = {}): LadderRequest => ({
  symbol: "EURUSD",
  side: "BUY",
  kind: "limit",
  from: 1.085,
  to: 1.08,
  spacing: { mode: "count", levels: 6 },
  lots: { mode: "flat", lot: 0.1 },
  slOffsetPoints: 200,
  tpOffsetPoints: 400,
  ...over,
});
const build = (r = req(), s: Parameters<typeof buildLadder>[1] = snap, caps = CAPS) =>
  buildLadder(r, s, ID, caps);
const ok = (r: ReturnType<typeof build>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.plan;
};
const prices = (r: ReturnType<typeof build>) => ok(r).items.map((i) => i.openPrice);

describe("OD2 pending ladder", () => {
  it("R5.4 count mode: A to B inclusive, evenly spaced, tagged per R9.1", () => {
    const p = ok(build());
    expect(p.items.map((i) => i.openPrice)).toEqual([1.085, 1.084, 1.083, 1.082, 1.081, 1.08]);
    expect(p.items.map((i) => i.clientId)).toEqual(["q90", "q91", "q92", "q93", "q94", "q95"]);
    for (const i of p.items) {
      expect(i).toMatchObject({
        op: "pending",
        type: "BUY_LIMIT",
        volume: 0.1,
        magic: ID.magic,
        comment: "OD:L1",
      });
    }
    expect(p).toMatchObject({ levels: 6, totalLots: 0.6 });
  });

  it("R5.4: N = 1 is a single level at A; A = B is one level", () => {
    expect(prices(build(req({ spacing: { mode: "count", levels: 1 } })))).toEqual([1.085]);
    expect(prices(build(req({ to: 1.085, spacing: { mode: "step", points: 50 } })))).toEqual([1.085]);
  });

  it("R5.4: rounding to tick can merge levels: deduplicated and reported", () => {
    // US30 ticks are 0.25: 5 levels across 0.5 collapse to 3 distinct prices.
    const usq = quote(42_000, 42_002, "US30");
    const p = ok(
      build(
        req({
          symbol: "US30",
          from: 41_900,
          to: 41_900.5,
          spacing: { mode: "count", levels: 5 },
          slOffsetPoints: 500,
          tpOffsetPoints: 500,
        }),
        { spec: US30, quote: usq },
      ),
    );
    expect(p.items.map((i) => i.openPrice)).toEqual([41_900, 41_900.25, 41_900.5]);
    expect(p.warnings).toContain("5 levels requested, 3 distinct after rounding to the tick.");
  });

  it("R5.4 step mode: every K points from A toward B; B only if it lands exactly on a step", () => {
    expect(prices(build(req({ spacing: { mode: "step", points: 200 } })))).toEqual([1.085, 1.083, 1.081]);
    expect(prices(build(req({ spacing: { mode: "step", points: 250 } })))).toEqual([1.085, 1.0825, 1.08]);
    // Upward ladders work the same way (sell limits above the bid).
    expect(
      prices(build(req({ side: "SELL", from: 1.087, to: 1.089, spacing: { mode: "step", points: 100 } }))),
    ).toEqual([1.087, 1.088, 1.089]);
  });

  it("R5.5: type must match the market (buy limit below ask, buy stop above ask, sell limit above bid, sell stop below bid), ≥ d away", () => {
    expect(build(req({ kind: "stop" })).ok).toBe(false); // buy stops below the ask: wrong type
    const stop = ok(
      build(req({ kind: "stop", from: 1.087, to: 1.089, spacing: { mode: "count", levels: 3 } })),
    );
    expect(stop.items[0]?.type).toBe("BUY_STOP");
    const sellLimit = ok(
      build(req({ side: "SELL", from: 1.087, to: 1.089, spacing: { mode: "count", levels: 3 } })),
    );
    expect(sellLimit.items.map((i) => i.type)).toEqual(["SELL_LIMIT", "SELL_LIMIT", "SELL_LIMIT"]);
    expect(build(req({ side: "SELL", kind: "stop" })).ok).toBe(true); // sell stops below the bid
    // A level inside d of the market is refused, and the error lists every bad level.
    const near = build(req({ from: 1.0861, to: 1.0855, spacing: { mode: "count", levels: 3 } }), {
      spec: { ...EURUSD, stopsLevel: 30 },
      quote: Q,
    });
    expect(!near.ok && near.error.code).toBe("PLAN_INVALID");
    expect(!near.ok && near.error.message).toMatch(/1\.08610.*1\.08580/);
  });

  it("R5.6 + R5.6a: SL/TP are offsets from each level, at least d from it; inside d refuses the ladder", () => {
    const p = ok(build());
    expect([p.items[0]?.sl, p.items[0]?.tp]).toEqual([1.083, 1.089]);
    expect([p.items[5]?.sl, p.items[5]?.tp]).toEqual([1.078, 1.084]);
    const sell = ok(
      build(req({ side: "SELL", from: 1.087, to: 1.089, spacing: { mode: "count", levels: 3 } })),
    );
    expect([sell.items[0]?.sl, sell.items[0]?.tp]).toEqual([1.089, 1.083]);
    const tight = build(req({ slOffsetPoints: 10 }), { spec: { ...EURUSD, stopsLevel: 30 }, quote: Q });
    expect(!tight.ok && tight.error.message).toMatch(/R5\.6a/);
  });

  it("R0.4: a stop that would land at or below zero refuses the ladder (0 means 'no stop' on the MT5 wire)", () => {
    const tiny = quote(0.0101, 0.0102, "EURUSD");
    const r = build(
      req({ from: 0.0005, to: 0.0004, spacing: { mode: "count", levels: 2 }, slOffsetPoints: 60 }),
      { spec: EURUSD, quote: tiny },
    );
    expect(!r.ok && r.error.message).toMatch(/R0\.4/);
  });

  it("non-negotiable 9: no SL is allowed but loud", () => {
    const p = ok(build(req({ slOffsetPoints: undefined })));
    expect(p.items.every((i) => i.sl === null)).toBe(true);
    expect(p.warnings).toContain("No stop loss: the loss on these orders is limited only by your account.");
  });

  it("R9.5 scaled lots: linear from start to end, each rounded DOWN to the step; total shown", () => {
    const up = ok(build(req({ lots: { mode: "scaled", start: 0.1, end: 0.35 } })));
    expect(up.items.map((i) => i.volume)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(up.totalLots).toBe(1.35);
    const down = ok(
      build(req({ spacing: { mode: "count", levels: 4 }, lots: { mode: "scaled", start: 0.1, end: 0.01 } })),
    );
    expect(down.items.map((i) => i.volume)).toEqual([0.1, 0.07, 0.04, 0.01]);
    // 0.1 → 0.2 over 4 levels is 0.1333…: rounds down to 0.13, never up.
    expect(
      ok(
        build(req({ spacing: { mode: "count", levels: 4 }, lots: { mode: "scaled", start: 0.1, end: 0.2 } })),
      ).items.map((i) => i.volume),
    ).toEqual([0.1, 0.13, 0.16, 0.2]);
    expect(build(req({ lots: { mode: "scaled", start: 0.005, end: 0.1 } })).ok).toBe(false); // first level under volumeMin
  });

  it("R5.2: levels and total lots are capped; a huge step range is refused before it's built", () => {
    expect(build(req({ spacing: { mode: "count", levels: 101 } })).ok).toBe(false);
    expect(build(req({ lots: { mode: "flat", lot: 1 } })).ok).toBe(false); // 6 lots > 5
    const r = build(req({ from: 1.085, to: 0.5, spacing: { mode: "step", points: 1 } }));
    expect(!r.ok && r.error.message).toMatch(/over your cap of 100/);
  });

  it("R0.6: nonsense input is VALIDATION, never a throw", () => {
    for (const bad of [
      req({ spacing: { mode: "count", levels: 0 } }),
      req({ spacing: { mode: "count", levels: 2.5 } }),
      req({ spacing: { mode: "step", points: 0 } }),
      req({ from: Number.NaN }),
      req({ to: Number.POSITIVE_INFINITY }),
      req({ lots: { mode: "flat", lot: -1 } }),
      req({ slOffsetPoints: 0 }),
      req({ tpOffsetPoints: 1.5 }),
    ]) {
      const r = build(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.error.code, JSON.stringify(bad)).toBe("VALIDATION");
    }
    expect(build(req(), { spec: null, quote: Q })).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE" },
    });
  });

  it("property: every accepted level has the right type for the market, ≥ d away, and stops ≥ d from its own price", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("BUY" as const, "SELL" as const),
        fc.constantFrom("limit" as const, "stop" as const),
        fc.integer({ min: -3_000, max: 3_000 }),
        fc.integer({ min: -3_000, max: 3_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 100 }),
        (side, kind, aOff, bOff, levels, stopsLevel) => {
          const spec = { ...EURUSD, stopsLevel };
          const r = buildLadder(
            req({
              side,
              kind,
              from: 1.086 + aOff * 1e-5,
              to: 1.086 + bOff * 1e-5,
              spacing: { mode: "count", levels },
              slOffsetPoints: 150,
              tpOffsetPoints: 150,
            }),
            { spec, quote: Q },
            ID,
            CAPS,
          );
          if (!r.ok) return;
          const bid = toPoints(Q.bid, spec);
          const ask = toPoints(Q.ask, spec);
          const d = stopsLevel + 2;
          for (const i of r.plan.items) {
            const p = toPoints(i.openPrice, spec);
            if (i.type === "BUY_LIMIT") expect(p).toBeLessThan(ask - d + 1);
            if (i.type === "BUY_STOP") expect(p).toBeGreaterThan(ask + d - 1);
            if (i.type === "SELL_LIMIT") expect(p).toBeGreaterThan(bid + d - 1);
            if (i.type === "SELL_STOP") expect(p).toBeLessThan(bid - d + 1);
            const sl = toPoints(i.sl ?? 0, spec);
            expect(Math.abs(sl - p)).toBeGreaterThanOrEqual(d);
          }
        },
      ),
    );
  });
});

describe("entryProblems: execute re-checks every stored entry against the market NOW (§7 for entries)", () => {
  it("valid at preview, still valid → no problem; market moved through a market SL or a pending level → named", async () => {
    const { entryProblems } = await import("@/domain/entries");
    const { marketFrom } = await import("@/domain/rules");
    const p = ok(build());
    const m = marketFrom(EURUSD, Q);
    expect(p.items.flatMap((i) => entryProblems(i, m))).toEqual([]);
    // Ask falls to 1.0849: the 1.0850 buy limit is now ABOVE the ask.
    const crashed = marketFrom(EURUSD, quote(1.0848, 1.0849));
    expect(entryProblems(p.items[0]!, crashed)[0]).toMatch(/buy limit/);
    const { buildMarketBatch } = await import("@/domain/entries");
    const mb = buildMarketBatch(
      { symbol: "EURUSD", side: "BUY", count: 1, volume: 0.1, stopLoss: { kind: "points", value: 150 } },
      { spec: EURUSD, quote: Q },
      ID,
      CAPS,
    );
    if (!mb.ok) throw new Error("setup");
    const entry = mb.plan.items[0]!;
    expect(entryProblems(entry, m)).toEqual([]);
    // Bid drops to the SL: a buy SL must be below the bid.
    expect(entryProblems(entry, marketFrom(EURUSD, quote(1.0845, 1.0846)))[0]).toMatch(/SL/);
  });
});
