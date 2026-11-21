/**
 * Findings from the Phase 02 adversarial safety review, as regression tests.
 * Critical: a level could round to 0 (MT5 "remove"). High: close-now could throw.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildPlan, type MarketSnapshot, type PlanRequest, type PlanResult } from "@/domain/plan";
import { roundToTick } from "@/domain/price";
import type { Position, SymbolSpec } from "@/domain/types";
import { EURUSD, position, quote, US30 } from "./fixtures";

const SPEC: SymbolSpec = { ...EURUSD, stopsLevel: 10, freezeLevel: 5 };
const ALL = { symbol: "EURUSD", side: "ALL" } as const;
const snap = (positions: Position[], over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  positions,
  orders: [],
  spec: SPEC,
  quote: quote(1.086, 1.0861),
  ...over,
});
const ok = (r: PlanResult) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.plan;
};

describe("CRITICAL R0.4: a level at or below 0 is never emitted", () => {
  it("levels: a tiny SL that rounds to 0 would wipe an existing SL → rejected", () => {
    const r = buildPlan(
      { action: "levels", filter: ALL, stopLoss: 0.000004 },
      snap([position("BUY", { sl: 1.08, tp: 1.09 })]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PLAN_INVALID");
      expect(r.error.message).toContain(
        'Buy SL would be 0 or below on EURUSD, which MT5 reads as "no SL" (1 position, R0.4).',
      );
    }
  });

  it("levels: a sub-tick SL on an index rounds to 0 → rejected", () => {
    const r = buildPlan(
      { action: "levels", filter: { symbol: "US30", side: "ALL" }, stopLoss: 0.1 },
      {
        positions: [position("BUY", { symbol: "US30", openPrice: 42000, sl: 41000 })],
        orders: [],
        spec: US30,
        quote: quote(42000, 42001, "US30"),
      },
    );
    expect(r.ok).toBe(false);
  });

  it("closeAt: a tiny X would become buy SL 0 / sell TP 0 → rejected", () => {
    const r = buildPlan(
      { action: "closeAt", filter: ALL, price: 0.000001 },
      snap([position("BUY", { sl: 1.08 }), position("SELL", { tp: 1.08 })]),
    );
    expect(r.ok).toBe(false);
  });

  it("lock: a distance ≥ the price would give SL 0 or negative → rejected", () => {
    for (const n of [108600, 200000]) {
      const r = buildPlan(
        { action: "lock", filter: ALL, distancePoints: n },
        snap([position("BUY", { profit: 5, openPrice: 0.5 })]),
      );
      expect(r.ok).toBe(false);
    }
  });
});

describe("HIGH R4.7: close-now never throws on broken market data", () => {
  const close: PlanRequest = { action: "close", filter: ALL, cancelPending: false };

  it("a quote too large to convert to points", () => {
    const plan = ok(buildPlan(close, snap([position("BUY")], { quote: quote(1e12, 1e12) })));
    expect(plan.items).toHaveLength(1);
    expect(plan.quote).toBeNull();
  });

  it("a bad buffer option", () => {
    expect(buildPlan(close, snap([position("BUY")]), { bufferPoints: -1 }).ok).toBe(true);
  });

  it("even broker data that throws when read", () => {
    const hostile = {
      ...SPEC,
      get point(): number {
        throw new Error("broker object exploded");
      },
    };
    const plan = ok(buildPlan(close, snap([position("BUY")], { spec: hostile })));
    expect(plan.items).toHaveLength(1);
    expect(plan.quote).toBeNull();
  });

  it("non-close actions report the same problems as BROKER_UNAVAILABLE instead of throwing", () => {
    const levels: PlanRequest = { action: "levels", filter: ALL, stopLoss: 1.08 };
    expect(buildPlan(levels, snap([position("BUY")], { quote: quote(1e12, 1e12) }))).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE", details: ["quote: price out of range for this symbol"] },
    });
    expect(buildPlan(levels, snap([position("BUY")]), { bufferPoints: 1.5 })).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE", details: ["config: buffer must be an integer 0..1000 points"] },
    });
  });
});

describe("R0.5 snapshot sanity", () => {
  it("bad position data refuses modify plans, naming the ticket and field", () => {
    const r = buildPlan(
      { action: "levels", filter: ALL, stopLoss: 1.08 },
      snap([position("BUY", { id: "t1", profit: Number.NaN, sl: 0 })]),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE", details: ["position t1: profit", "position t1: sl"] },
    });
  });

  it("covers every field, and orders too", () => {
    const r = buildPlan(
      { action: "levels", filter: ALL, stopLoss: 1.08 },
      snap([position("BUY", { id: "", openPrice: 0, volume: -1, tp: Number.NaN, magic: -1 })], {
        orders: [
          {
            id: "",
            symbol: "EURUSD",
            type: "BUY_LIMIT",
            volume: 0,
            openPrice: Number.NaN,
            sl: -1,
            tp: 0,
            magic: 1.5,
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "BROKER_UNAVAILABLE") {
      expect(r.error.details).toEqual([
        "position with an empty id",
        "position (no id): openPrice",
        "position (no id): volume",
        "position (no id): tp",
        "position (no id): magic",
        "order with an empty id",
        "order (no id): openPrice",
        "order (no id): volume",
        "order (no id): sl",
        "order (no id): tp",
        "order (no id): magic",
      ]);
    }
  });

  it("an existing level that is 'positive' but 0 points on the grid is caught (found by the fuzz test)", () => {
    const r = buildPlan(
      { action: "closeAt", filter: ALL, price: 1.08 },
      snap([position("SELL", { id: "z", sl: 0.000004 })]),
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE", details: ["position z: sl off the price grid"] },
    });
    const r2 = buildPlan(
      { action: "levels", filter: ALL, stopLoss: 1.08 },
      snap([position("BUY", { id: "y", tp: 1e300, openPrice: 1e-7 })]),
    );
    expect(r2).toMatchObject({
      ok: false,
      error: { details: ["position y: openPrice off the price grid", "position y: tp off the price grid"] },
    });
  });

  it("bad data on another symbol doesn't block this one", () => {
    const other = position("BUY", { symbol: "GBPUSD", profit: Number.NaN });
    expect(
      buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([other, position("BUY")])).ok,
    ).toBe(true);
  });

  it("close-now still closes by ticket: unknown P/L first, bad volume shown as null, with a warning", () => {
    const plan = ok(
      buildPlan(
        { action: "close", filter: ALL, cancelPending: false },
        snap([
          position("BUY", { id: "a", profit: -50 }),
          position("BUY", { id: "b", profit: Number.NaN, volume: Number.NaN }),
        ]),
      ),
    );
    expect(plan.items).toEqual([
      { op: "close", positionId: "b", side: "BUY", volume: null },
      { op: "close", positionId: "a", side: "BUY", volume: 0.1 },
    ]);
    expect(
      plan.warnings.some((w) =>
        w.startsWith("Some broker data looked wrong (position b: volume, position b: profit)"),
      ),
    ).toBe(true);
  });
});

describe("R0.6 inputs must fit", () => {
  it.each<PlanRequest>([
    { action: "levels", filter: ALL, stopLoss: 1e300 },
    { action: "closeAt", filter: ALL, price: 1e300 },
  ])("out-of-range price → VALIDATION, not a throw ($action)", (req) => {
    expect(buildPlan(req, snap([position("BUY")]))).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "That price is out of range for EURUSD. (R0.6)" },
    });
  });

  it.each<PlanRequest>([
    { action: "breakeven", filter: ALL, offsetPoints: Number.MAX_SAFE_INTEGER },
    { action: "lock", filter: ALL, distancePoints: 1_000_001 },
  ])("oversized point parameters → VALIDATION ($action)", (req) => {
    expect(buildPlan(req, snap([position("BUY")])).ok).toBe(false);
  });
});

describe("R2.11 preserved level inside d is flagged", () => {
  it("warns with a count when a kept level could make the broker reject the item", () => {
    // Existing TP 1.08611 is 11 points above bid: inside d (12), outside freeze (5).
    const plan = ok(
      buildPlan(
        { action: "levels", filter: ALL, stopLoss: 1.08 },
        snap([position("BUY", { tp: 1.08611 }), position("BUY")]),
      ),
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.warnings).toEqual([
      "1 position keep an existing level inside the broker's stop distance. The broker may reject those items; they'd be reported as failed, not done. (R2.11)",
    ]);
  });
});

describe("single rounding straight to the tick (review: low)", () => {
  it("tick of 10 points: 1.080046 goes to the nearest tick 1.08000, not 1.08010", () => {
    expect(roundToTick(1.080046, { point: 0.00001, digits: 5, tickSize: 0.0001 })).toBe(1.08);
  });
});

describe("fuzz: buildPlan never throws and never emits a bad level", () => {
  const num = fc.oneof(
    fc.double({ noNaN: false }),
    fc.constantFrom(0, -0, 1e-9, 0.000004, 1.08, 1.09, 1e12, 1e300, Number.NaN, Number.POSITIVE_INFINITY),
  );
  const request: fc.Arbitrary<PlanRequest> = fc.oneof(
    fc.record({
      action: fc.constant("levels" as const),
      filter: fc.constant(ALL),
      stopLoss: num,
      takeProfit: num,
    }),
    fc.record({ action: fc.constant("closeAt" as const), filter: fc.constant(ALL), price: num }),
    fc.record({
      action: fc.constant("close" as const),
      filter: fc.constant(ALL),
      cancelPending: fc.boolean(),
    }),
    fc.record({
      action: fc.constant("breakeven" as const),
      filter: fc.constant(ALL),
      offsetPoints: fc.oneof(fc.integer(), num),
    }),
    fc.record({
      action: fc.constant("lock" as const),
      filter: fc.constant(ALL),
      distancePoints: fc.oneof(fc.integer(), num),
    }),
  );
  const pos = fc
    .record({
      side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
      openPrice: fc.oneof(fc.double({ min: 1.07, max: 1.1, noNaN: true }), num),
      sl: fc.option(fc.oneof(fc.double({ min: 1.05, max: 1.12, noNaN: true }), num)),
      tp: fc.option(fc.oneof(fc.double({ min: 1.05, max: 1.12, noNaN: true }), num)),
      profit: fc.oneof(fc.integer({ min: -100, max: 100 }), num),
      volume: fc.oneof(fc.constant(0.1), num),
    })
    .map((p) => position(p.side, p));

  it("holds for thousands of hostile inputs", () => {
    fc.assert(
      fc.property(
        request,
        fc.array(pos, { minLength: 1, maxLength: 8 }),
        fc.option(fc.integer({ min: -3, max: 20 })),
        (req, positions, buffer) => {
          const r = buildPlan(req, snap(positions), buffer === null ? {} : { bufferPoints: buffer });
          if (!r.ok) return;
          for (const item of r.plan.items) {
            if (item.op !== "modify") continue;
            for (const level of [item.sl, item.tp]) {
              if (level === null) continue;
              expect(Number.isFinite(level)).toBe(true);
              expect(level).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
