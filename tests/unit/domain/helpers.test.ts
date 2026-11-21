import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideBreakeven, decideLock } from "@/domain/helpers";
import { buildPlan, type MarketSnapshot, type PlanResult } from "@/domain/plan";
import { toPoints } from "@/domain/price";
import { checkLevel, marketFrom, ref } from "@/domain/rules";
import type { Position, Side, SymbolSpec } from "@/domain/types";
import { EURUSD, position, quote, US30 } from "./fixtures";

// bid 108600, ask 108610, d = 12, freeze 5. Buy SL must be < 108588; sell SL must be > 108622.
const SPEC: SymbolSpec = { ...EURUSD, stopsLevel: 10, freezeLevel: 5 };
const M = marketFrom(SPEC, quote(1.086, 1.0861));
const IDX = marketFrom(US30, quote(42100, 42101, "US30"));
const price = (pts: number) => pts / 100000;

describe("R8.1 break-even", () => {
  it("buy: SL = open + N when far enough in profit; TP preserved", () => {
    const pos = position("BUY", { openPrice: 1.085, tp: 1.09 });
    expect(decideBreakeven(pos, 10, M)).toEqual({ kind: "modify", sl: 108510, tp: 109000 });
  });

  it("sell: SL = open − N", () => {
    const pos = position("SELL", { openPrice: 1.087 });
    expect(decideBreakeven(pos, 10, M)).toEqual({ kind: "modify", sl: 108690, tp: null });
  });

  it("N = 0 is exact entry", () => {
    expect(decideBreakeven(position("BUY", { openPrice: 1.085 }), 0, M)).toMatchObject({ sl: 108500 });
  });

  it.each<[Side, number, number, boolean]>([
    // side, open (pts), N, qualifies. Boundary: buy BE SL must be < 108588; sell > 108622.
    ["BUY", 108577, 10, true], // 108587
    ["BUY", 108578, 10, false], // 108588 = boundary
    ["SELL", 108633, 10, true], // 108623
    ["SELL", 108632, 10, false], // 108622 = boundary
  ])("%s open %i + %i → qualifies=%s", (side, open, n, qualifies) => {
    const d = decideBreakeven(position(side, { openPrice: price(open) }), n, M);
    expect(d.kind).toBe(qualifies ? "modify" : "skip");
    if (!qualifies) expect(d).toEqual({ kind: "skip", rule: "R8.1" });
  });

  it("losing position → not far enough in profit", () => {
    expect(decideBreakeven(position("BUY", { openPrice: 1.087 }), 0, M)).toEqual({
      kind: "skip",
      rule: "R8.1",
    });
  });

  it("R8.3: never moves an existing SL to a worse level", () => {
    const pos = position("BUY", { openPrice: 1.085, sl: 1.0855 });
    expect(decideBreakeven(pos, 10, M)).toEqual({ kind: "skip", rule: "R8.3" });
    const sell = position("SELL", { openPrice: 1.087, sl: 1.0865 });
    expect(decideBreakeven(sell, 10, M)).toEqual({ kind: "skip", rule: "R8.3" });
  });

  it("already at break-even → unchanged (R2.8)", () => {
    expect(decideBreakeven(position("BUY", { openPrice: 1.085, sl: 1.0851 }), 10, M)).toEqual({
      kind: "skip",
      rule: "R2.8",
    });
  });

  it("R8.4: off-grid result rounds toward profit (index quarter ticks)", () => {
    // Buy open 42000.00 + 10 points (0.10) = 42000.10 → up to 42000.25. Sell 42200.00 − 0.10 → down to 42199.75.
    expect(decideBreakeven(position("BUY", { symbol: "US30", openPrice: 42000 }), 10, IDX)).toMatchObject({
      sl: 4200025,
    });
    expect(decideBreakeven(position("SELL", { symbol: "US30", openPrice: 42200 }), 10, IDX)).toMatchObject({
      sl: 4219975,
    });
  });

  it("property: a break-even SL never locks less than open ± N, and is always valid", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>("BUY", "SELL"),
        fc.integer({ min: 4150000, max: 4250000 }),
        fc.integer({ min: 0, max: 400 }),
        (side, openPts, n) => {
          const pos: Position = position(side, { symbol: "US30", openPrice: openPts / 100 });
          const d = decideBreakeven(pos, n, IDX);
          if (d.kind !== "modify" || d.sl === null) return;
          if (side === "BUY") expect(d.sl).toBeGreaterThanOrEqual(openPts + n);
          else expect(d.sl).toBeLessThanOrEqual(openPts - n);
          expect(checkLevel(side, "SL", d.sl, IDX)).toBeNull();
        },
      ),
    );
  });
});

describe("R8.2 lock profit", () => {
  it("buy: SL = bid − N for in-profit positions", () => {
    expect(decideLock(position("BUY", { profit: 5 }), 20, M)).toEqual({
      kind: "modify",
      sl: 108580,
      tp: null,
    });
  });

  it("sell: SL = ask + N", () => {
    expect(decideLock(position("SELL", { profit: 5 }), 20, M)).toEqual({
      kind: "modify",
      sl: 108630,
      tp: null,
    });
  });

  it("only in-profit positions (0 is not profit)", () => {
    expect(decideLock(position("BUY", { profit: 0 }), 20, M)).toEqual({ kind: "skip", rule: "R8.2" });
    expect(decideLock(position("BUY", { profit: -3 }), 20, M)).toEqual({ kind: "skip", rule: "R8.2" });
  });

  it("N inside the stop distance → invalid (a parameter error, not a skip)", () => {
    expect(decideLock(position("BUY", { profit: 5 }), 12, M)).toEqual({
      kind: "invalid",
      violations: [{ rule: "R2.1", side: "BUY", level: "SL", boundary: 108588, relation: "below" }],
    });
  });

  it("R8.3: never loosens a tighter existing SL", () => {
    expect(decideLock(position("BUY", { profit: 5, sl: 1.08585 }), 20, M)).toEqual({
      kind: "skip",
      rule: "R8.3",
    });
  });

  it("R8.4: off-grid result rounds away from price", () => {
    const buy = decideLock(position("BUY", { symbol: "US30", profit: 5 }), 10, IDX); // 42099.90 → 42099.75
    const sell = decideLock(position("SELL", { symbol: "US30", profit: 5 }), 10, IDX); // 42101.10 → 42101.25
    expect(buy).toMatchObject({ sl: 4209975 });
    expect(sell).toMatchObject({ sl: 4210125 });
  });

  it("property: a lock SL is never closer than N to price", () => {
    fc.assert(
      fc.property(fc.constantFrom<Side>("BUY", "SELL"), fc.integer({ min: 1, max: 500 }), (side, n) => {
        const d = decideLock(position(side, { symbol: "US30", profit: 1 }), n, IDX);
        if (d.kind !== "modify" || d.sl === null) return;
        expect(Math.abs(d.sl - ref(side, IDX))).toBeGreaterThanOrEqual(n);
      }),
    );
  });
});

describe("plan builder: breakeven and lock", () => {
  const snap = (positions: Position[]): MarketSnapshot => ({
    positions,
    orders: [],
    spec: SPEC,
    quote: quote(1.086, 1.0861),
  });
  const filter = { symbol: "EURUSD", side: "ALL" } as const;
  const okPlan = (r: PlanResult) => {
    if (!r.ok) throw new Error(r.error.message);
    return r.plan;
  };

  it("break-even plan lists skipped positions with reasons", () => {
    const good = position("BUY", { openPrice: 1.085 });
    const near = position("BUY", { openPrice: 1.0859 });
    const better = position("BUY", { openPrice: 1.085, sl: 1.0857 });
    const plan = okPlan(
      buildPlan({ action: "breakeven", filter, offsetPoints: 10 }, snap([good, near, better])),
    );
    expect(plan.items).toEqual([{ op: "modify", positionId: good.id, side: "BUY", sl: 1.0851, tp: null }]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { id: near.id, reason: "not far enough in profit" },
        { id: better.id, reason: "SL already better" },
      ]),
    );
    expect(plan.warnings).toEqual(["Excludes swaps and commission. (R8.5)"]);
  });

  it("lock plan: losers skipped as not in profit; nothing qualifying → warning", () => {
    const plan = okPlan(
      buildPlan({ action: "lock", filter, distancePoints: 20 }, snap([position("SELL", { profit: -1 })])),
    );
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("not in profit");
    expect(plan.warnings).toContain("Nothing to change: no matching position qualifies right now.");
  });

  it("lock distance inside d rejects the whole plan with the boundary", () => {
    const r = buildPlan(
      { action: "lock", filter, distancePoints: 5 },
      snap([position("BUY", { profit: 3 }), position("BUY", { profit: 4 })]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("Buy SL must be below 1.08588 (2 positions, R2.1).");
  });

  it.each([
    [
      { action: "breakeven", filter, offsetPoints: -1 },
      "Break-even offset must be a whole number of points, 0 or more.",
    ],
    [
      { action: "breakeven", filter, offsetPoints: 1.5 },
      "Break-even offset must be a whole number of points, 0 or more.",
    ],
    [
      { action: "lock", filter, distancePoints: 0 },
      "Lock distance must be a whole number of points, 1 or more.",
    ],
  ] as const)("validates parameters: %o", (req, message) => {
    expect(buildPlan(req, snap([position("BUY")]))).toEqual({
      ok: false,
      error: { code: "VALIDATION", message },
    });
  });

  it("break-even points are integer-exact across many positions", () => {
    const positions = Array.from({ length: 200 }, (_, i) =>
      position("BUY", { id: `b${i}`, openPrice: 1.08 + i / 100000 }),
    );
    const plan = okPlan(buildPlan({ action: "breakeven", filter, offsetPoints: 3 }, snap(positions)));
    for (const item of plan.items) {
      if (item.op !== "modify" || item.sl === null) continue;
      const pos = positions.find((p) => p.id === item.positionId)!;
      expect(toPoints(item.sl, SPEC) - toPoints(pos.openPrice, SPEC)).toBe(3);
    }
  });
});
