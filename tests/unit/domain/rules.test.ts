import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { invariant, InvariantError } from "@/domain/invariant";
import { points } from "@/domain/price";
import {
  checkLevel,
  decideModify,
  DEFAULT_BUFFER_POINTS,
  effectiveChange,
  frozenLevel,
  marketFrom,
  mergeLevels,
  quoteProblems,
  ref,
  stopDistance,
  validateLevels,
  type LevelKind,
} from "@/domain/rules";
import type { Points, Side, SymbolSpec } from "@/domain/types";
import { EURUSD, position, quote } from "./fixtures";

/**
 * Market used by the boundary tables:
 *   bid 1.08600 (108600 pts), ask 1.08610 (108610 pts), stopsLevel 10, freezeLevel 5, buffer 2 → d = 12.
 *   Buy ref = bid:  SL must be < 108588, TP must be > 108612.
 *   Sell ref = ask: SL must be > 108622, TP must be < 108598.
 */
const SPEC: SymbolSpec = { ...EURUSD, stopsLevel: 10, freezeLevel: 5 };
const M = marketFrom(SPEC, quote(1.086, 1.0861));
const P = (n: number): Points => points(n);
const price = (pts: number) => pts / 100000;

describe("§0 market", () => {
  it("d = max(stopsLevel, freezeLevel) + buffer (default 2)", () => {
    expect(DEFAULT_BUFFER_POINTS).toBe(2);
    expect(stopDistance(SPEC)).toBe(12);
    expect(stopDistance({ ...SPEC, freezeLevel: 30 })).toBe(32);
    expect(stopDistance({ ...SPEC, stopsLevel: 0, freezeLevel: 0 }, 0)).toBe(0);
    expect(M).toMatchObject({ bid: 108600, ask: 108610, d: 12, freeze: 5 });
  });

  it("ref: a buy closes at bid, a sell at ask", () => {
    expect(ref("BUY", M)).toBe(108600);
    expect(ref("SELL", M)).toBe(108610);
  });

  it("refuses a quote for another symbol and a bad buffer", () => {
    expect(() => marketFrom(SPEC, quote(150, 150.01, "USDJPY"))).toThrow(InvariantError);
    expect(() => marketFrom(SPEC, quote(1.086, 1.0861), -1)).toThrow(InvariantError);
    expect(() => marketFrom(SPEC, quote(1.086, 1.0861), 1.5)).toThrow(InvariantError);
  });

  it.each([
    [quote(1.086, 1.0861), []],
    [quote(0, 1.0861), ["bid must be > 0"]],
    [quote(1.086, Number.NaN), ["ask must be > 0"]],
    [quote(1.0861, 1.086), ["ask must be ≥ bid"]],
    [quote(-1, 0), ["bid must be > 0", "ask must be > 0"]],
  ])("quoteProblems(%o)", (q, expected) => {
    expect(quoteProblems(q)).toEqual(expected);
  });
});

describe("R2.1 to R2.4: exact boundary, one inside, one outside", () => {
  it.each<[string, Side, LevelKind, number, number, number, "below" | "above"]>([
    // rule, side, level, boundary, one inside, one outside, relation
    ["R2.1", "BUY", "SL", 108588, 108589, 108587, "below"],
    ["R2.2", "BUY", "TP", 108612, 108611, 108613, "above"],
    ["R2.3", "SELL", "SL", 108622, 108621, 108623, "above"],
    ["R2.4", "SELL", "TP", 108598, 108599, 108597, "below"],
  ])("%s %s %s", (rule, side, level, boundary, inside, outside, relation) => {
    const violation = { rule, side, level, boundary, relation };
    expect(checkLevel(side, level, P(boundary), M)).toEqual(violation);
    expect(checkLevel(side, level, P(inside), M)).toEqual(violation);
    expect(checkLevel(side, level, P(outside), M)).toBeNull();
  });

  it("R2.3 sell SL is measured from ASK: clearing bid + d is not enough", () => {
    // 108613 is > bid + d (108612) but not > ask + d (108622).
    expect(checkLevel("SELL", "SL", P(108613), M)?.rule).toBe("R2.3");
  });

  it("R2.2 buy TP is measured from BID: it only needs to clear bid + d, not ask + d", () => {
    expect(checkLevel("BUY", "TP", P(108613), M)).toBeNull();
  });

  it("R2.4 sell TP is measured from ASK: below ask − d is valid even if above bid − d", () => {
    expect(checkLevel("SELL", "TP", P(108597), M)).toBeNull();
    expect(108597).toBeGreaterThan(108600 - 12);
  });

  it("with zero stops/freeze/buffer, a level exactly at price is still invalid (strict)", () => {
    const m0 = marketFrom({ ...SPEC, stopsLevel: 0, freezeLevel: 0 }, quote(1.086, 1.0861), 0);
    expect(checkLevel("BUY", "SL", P(108600), m0)?.rule).toBe("R2.1");
    expect(checkLevel("BUY", "SL", P(108599), m0)).toBeNull();
  });
});

describe("R2.5 and validateLevels", () => {
  it("returns every violation, SL first", () => {
    expect(validateLevels("BUY", { sl: P(108599), tp: P(108601) }, M).map((v) => v.rule)).toEqual([
      "R2.1",
      "R2.2",
    ]);
  });

  it("is empty when nothing is requested", () => {
    expect(validateLevels("SELL", {}, M)).toEqual([]);
  });

  it("R2.5: whenever both levels are valid, buy SL < TP and sell SL > TP (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>("BUY", "SELL"),
        fc.integer({ min: 100000, max: 120000 }),
        fc.integer({ min: 100000, max: 120000 }),
        (side, sl, tp) => {
          const v = validateLevels(side, { sl: P(sl), tp: P(tp) }, M);
          if (v.length === 0) expect(side === "BUY" ? sl < tp : sl > tp).toBe(true);
        },
      ),
    );
  });

  it("invariant throws InvariantError with a clear message", () => {
    expect(() => {
      invariant(false, "boom");
    }).toThrow("Invariant violated: boom");
    expect(() => {
      invariant(true, "fine");
    }).not.toThrow();
  });
});

describe("level validity properties over random markets", () => {
  const market = fc
    .record({
      bid: fc.integer({ min: 50000, max: 200000 }),
      spread: fc.integer({ min: 0, max: 80 }),
      stops: fc.integer({ min: 0, max: 60 }),
      freeze: fc.integer({ min: 0, max: 60 }),
      buffer: fc.integer({ min: 0, max: 5 }),
    })
    .map(({ bid, spread, stops, freeze, buffer }) =>
      marketFrom(
        { ...EURUSD, stopsLevel: stops, freezeLevel: freeze },
        quote(price(bid), price(bid + spread)),
        buffer,
      ),
    );
  const sideLevel = fc.tuple(fc.constantFrom<Side>("BUY", "SELL"), fc.constantFrom<LevelKind>("SL", "TP"));

  it("a valid level is always on the correct side of the closing price, by more than d", () => {
    fc.assert(
      fc.property(market, sideLevel, fc.integer({ min: -500, max: 500 }), (m, [side, level], offset) => {
        const value = P(ref(side, m) + offset);
        if (checkLevel(side, level, value, m) !== null) return;
        const isLoss = level === "SL";
        const mustBeBelow = side === "BUY" ? isLoss : !isLoss;
        if (mustBeBelow) expect(ref(side, m) - value).toBeGreaterThan(m.d);
        else expect(value - ref(side, m)).toBeGreaterThan(m.d);
      }),
    );
  });

  it("validity is monotonic: moving a valid level further from price, in its own direction, keeps it valid", () => {
    fc.assert(
      fc.property(
        market,
        sideLevel,
        fc.integer({ min: -500, max: 500 }),
        fc.integer({ min: 1, max: 500 }),
        (m, [side, level], offset, k) => {
          const value = ref(side, m) + offset;
          if (checkLevel(side, level, P(value), m) !== null) return;
          const mustBeBelow = side === "BUY" ? level === "SL" : level === "TP";
          const further = mustBeBelow ? value - k : value + k;
          expect(checkLevel(side, level, P(further), m)).toBeNull();
        },
      ),
    );
  });
});

describe("R2.7 preserve the untouched level", () => {
  it("SL-only change keeps the existing TP", () => {
    const pos = position("BUY", { sl: 1.085, tp: 1.09 });
    expect(mergeLevels(pos, { sl: P(108500) }, M)).toEqual({ sl: 108500, tp: 109000 });
  });

  it("TP-only change keeps the existing SL", () => {
    const pos = position("SELL", { sl: 1.09, tp: 1.08 });
    expect(mergeLevels(pos, { tp: P(108100) }, M)).toEqual({ sl: 109000, tp: 108100 });
  });

  it("a level the position never had stays null (none), it is not invented", () => {
    const pos = position("BUY", { sl: null, tp: null });
    expect(mergeLevels(pos, { sl: P(108500) }, M)).toEqual({ sl: 108500, tp: null });
  });

  it("property: decideModify never drops an existing level it wasn't asked to change", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>("BUY", "SELL"),
        fc.option(fc.integer({ min: 100000, max: 108500 })),
        fc.option(fc.integer({ min: 108700, max: 118000 })),
        fc.constantFrom<"sl" | "tp">("sl", "tp"),
        fc.integer({ min: 95000, max: 125000 }),
        (side, low, high, which, value) => {
          const [sl, tp] = side === "BUY" ? [low, high] : [high, low];
          const pos = position(side, {
            sl: sl === null ? null : price(sl),
            tp: tp === null ? null : price(tp),
          });
          const decision = decideModify(pos, { [which]: P(value) }, M);
          if (decision.kind !== "modify") return;
          const untouched = which === "sl" ? "tp" : "sl";
          const before = untouched === "sl" ? sl : tp;
          expect(decision[untouched]).toBe(before);
        },
      ),
    );
  });
});

describe("R2.8 no-op skip", () => {
  it("same SL as current → skip, no broker call", () => {
    const pos = position("BUY", { sl: 1.085 });
    expect(decideModify(pos, { sl: P(108500) }, M)).toEqual({ kind: "skip", rule: "R2.8" });
  });

  it("comparison is in points: 1.0849999999 counts as 1.08500", () => {
    const pos = position("BUY", { sl: 1.0849999999 });
    expect(decideModify(pos, { sl: P(108500) }, M)).toEqual({ kind: "skip", rule: "R2.8" });
  });

  it("an empty change is a no-op", () => {
    expect(decideModify(position("SELL"), {}, M)).toEqual({ kind: "skip", rule: "R2.8" });
  });

  it("an unchanged SL is not re-validated when only the TP changes", () => {
    // Existing SL 1.08590 is inside d (12) but outside freeze (5): fine to leave it, the user isn't moving it.
    const pos = position("BUY", { sl: 1.0859, tp: 1.09 });
    expect(effectiveChange(pos, { sl: P(108590), tp: P(109100) }, M)).toEqual({ tp: 109100 });
    // …but R2.11 flags it: the kept SL is inside d, so the broker might still reject the item.
    expect(decideModify(pos, { sl: P(108590), tp: P(109100) }, M)).toEqual({
      kind: "modify",
      sl: 108590,
      tp: 109100,
      preservedInsideD: "SL",
    });
  });
});

describe("R2.9 frozen positions are skipped", () => {
  it("existing TP exactly at the freeze distance → frozen (inclusive)", () => {
    const pos = position("BUY", { tp: price(108605) }); // |108605 − bid 108600| = 5 = freeze
    expect(frozenLevel(pos, M)).toEqual({ level: "TP", at: 108605 });
    expect(decideModify(pos, { sl: P(108000) }, M)).toEqual({
      kind: "skip",
      rule: "R2.9",
      frozen: { level: "TP", at: 108605 },
    });
  });

  it("one point outside the freeze distance → not frozen", () => {
    const pos = position("BUY", { tp: price(108606) });
    expect(frozenLevel(pos, M)).toBeNull();
    expect(decideModify(pos, { sl: P(108000) }, M).kind).toBe("modify");
  });

  it("a sell's existing SL is measured from ASK", () => {
    expect(frozenLevel(position("SELL", { sl: price(108615) }), M)).toEqual({ level: "SL", at: 108615 });
    expect(frozenLevel(position("SELL", { sl: price(108616) }), M)).toBeNull();
  });

  it("freeze level 0 never freezes", () => {
    const m0 = marketFrom({ ...SPEC, freezeLevel: 0 }, quote(1.086, 1.0861));
    expect(frozenLevel(position("BUY", { tp: 1.086 }), m0)).toBeNull();
  });

  it("invalid input is reported before frozen status (the user must fix it either way)", () => {
    const pos = position("BUY", { tp: price(108605) });
    expect(decideModify(pos, { sl: P(108599) }, M).kind).toBe("invalid");
  });
});

describe("decideModify", () => {
  it("returns the violations for an invalid change", () => {
    const decision = decideModify(position("SELL"), { sl: P(108615) }, M);
    expect(decision).toEqual({
      kind: "invalid",
      violations: [{ rule: "R2.3", side: "SELL", level: "SL", boundary: 108622, relation: "above" }],
    });
  });

  it("refuses a position from another symbol", () => {
    expect(() => decideModify(position("BUY", { symbol: "GBPUSD" }), { sl: P(1) }, M)).toThrow(
      InvariantError,
    );
  });
});
