import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignCloseAt, decideCloseAt } from "@/domain/closeAt";
import { points } from "@/domain/price";
import { checkLevel, marketFrom, ref } from "@/domain/rules";
import type { Side, SymbolSpec } from "@/domain/types";
import { EURUSD, position, quote } from "./fixtures";

// Same market as rules.test.ts: bid 108600, ask 108610, d = 12, freeze 5.
const SPEC: SymbolSpec = { ...EURUSD, stopsLevel: 10, freezeLevel: 5 };
const M = marketFrom(SPEC, quote(1.086, 1.0861));
const P = points;
const price = (pts: number) => pts / 100000;

describe("R3.1 too close", () => {
  it.each<[Side, number, boolean]>([
    ["BUY", 108612, true], // ref + d exactly → too close (≤)
    ["BUY", 108613, false],
    ["BUY", 108588, true], // ref − d exactly
    ["BUY", 108587, false],
    ["SELL", 108622, true],
    ["SELL", 108623, false],
    ["SELL", 108598, true],
    ["SELL", 108597, false],
    ["BUY", 108600, true], // at price
  ])("%s at %i → tooClose=%s", (side, x, tooClose) => {
    expect(assignCloseAt(side, P(x), M).kind).toBe(tooClose ? "tooClose" : "assign");
  });

  it("reports the reference price and distance so the UI can say why", () => {
    expect(assignCloseAt("SELL", P(108615), M)).toEqual({
      kind: "tooClose",
      rule: "R3.1",
      ref: 108610,
      d: 12,
    });
  });
});

describe("R3.2 assignment by side", () => {
  it("X above market: buys get TP, sells get SL", () => {
    expect(assignCloseAt("BUY", P(109000), M)).toEqual({ kind: "assign", set: "TP" });
    expect(assignCloseAt("SELL", P(109000), M)).toEqual({ kind: "assign", set: "SL" });
  });

  it("X below market: buys get SL, sells get TP", () => {
    expect(assignCloseAt("BUY", P(108000), M)).toEqual({ kind: "assign", set: "SL" });
    expect(assignCloseAt("SELL", P(108000), M)).toEqual({ kind: "assign", set: "TP" });
  });

  it("wide spread edge: X between bid + d and ask − d is a TP for BOTH sides", () => {
    // Spread 60 points, d = 12: X = 108630 is above bid+d (108612) and below ask−d (108648).
    const wide = marketFrom(SPEC, quote(1.086, 1.0866));
    expect(assignCloseAt("BUY", P(108630), wide)).toEqual({ kind: "assign", set: "TP" });
    expect(assignCloseAt("SELL", P(108630), wide)).toEqual({ kind: "assign", set: "TP" });
  });

  it("property: an assigned level always passes §2 for that side (correct side, beyond d)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 50000, max: 200000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 50 }),
        fc.constantFrom<Side>("BUY", "SELL"),
        fc.integer({ min: -2000, max: 2000 }),
        (bid, spread, stops, side, offset) => {
          const m = marketFrom({ ...EURUSD, stopsLevel: stops }, quote(price(bid), price(bid + spread)));
          const x = P(ref(side, m) + offset);
          const a = assignCloseAt(side, x, m);
          if (a.kind === "tooClose") {
            expect(Math.abs(x - ref(side, m))).toBeLessThanOrEqual(m.d);
            return;
          }
          expect(checkLevel(side, a.set, x, m)).toBeNull();
          const isAbove = x > ref(side, m);
          expect(a.set).toBe(side === "BUY" ? (isAbove ? "TP" : "SL") : isAbove ? "SL" : "TP");
        },
      ),
    );
  });
});

describe("R3.3 only the assigned level changes", () => {
  it("buy with an SL, X above → TP = X, SL preserved", () => {
    const pos = position("BUY", { sl: 1.08, tp: null });
    expect(decideCloseAt(pos, P(109000), M)).toEqual({ kind: "modify", sl: 108000, tp: 109000, set: "TP" });
  });

  it("sell with a TP, X above → SL = X, TP preserved", () => {
    const pos = position("SELL", { sl: null, tp: 1.08 });
    expect(decideCloseAt(pos, P(109000), M)).toEqual({ kind: "modify", sl: 109000, tp: 108000, set: "SL" });
  });

  it("overwrites the existing level on that side (README: setting a trigger replaces that side)", () => {
    const pos = position("BUY", { sl: 1.08, tp: 1.095 });
    expect(decideCloseAt(pos, P(109000), M)).toEqual({ kind: "modify", sl: 108000, tp: 109000, set: "TP" });
  });

  it("already at X → no-op skip (R2.8)", () => {
    expect(decideCloseAt(position("BUY", { tp: 1.09 }), P(109000), M)).toEqual({
      kind: "skip",
      rule: "R2.8",
      set: "TP",
    });
  });

  it("frozen position → skip (R2.9)", () => {
    expect(decideCloseAt(position("BUY", { sl: price(108596) }), P(109000), M)).toEqual({
      kind: "skip",
      rule: "R2.9",
      frozen: { level: "SL", at: 108596 },
      set: "TP",
    });
  });

  it("too close → passes the R3.1 reason through", () => {
    expect(decideCloseAt(position("SELL"), P(108615), M).kind).toBe("tooClose");
  });
});
