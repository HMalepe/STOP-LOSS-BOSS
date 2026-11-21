import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  comparePrices,
  formatPrice,
  fromPoints,
  points,
  pricesEqual,
  roundToTick,
  roundToTickPoints,
  specProblems,
  tickPoints,
  toPoints,
} from "@/domain/price";
import type { SymbolSpec } from "@/domain/types";
import { ALL_SPECS, EURUSD, US30, USDJPY, XAUUSD } from "./fixtures";

/** Realistic price ranges per symbol, so properties exercise real magnitudes. */
const RANGE: Record<string, [number, number]> = {
  EURUSD: [0.5, 2],
  USDJPY: [80, 200],
  XAUUSD: [1000, 5000],
  US30: [20000, 60000],
};
const priceFor = (spec: SymbolSpec) => {
  const [min, max] = RANGE[spec.symbol]!;
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
};

describe("§0 points", () => {
  it("brands safe integers and refuses anything else", () => {
    expect(points(5)).toBe(5);
    expect(() => points(1.5)).toThrow(RangeError);
    expect(() => points(Number.NaN)).toThrow(RangeError);
    expect(() => points(2 ** 60)).toThrow(RangeError);
  });

  it("toPoints refuses non-finite prices", () => {
    expect(() => toPoints(Number.POSITIVE_INFINITY, EURUSD)).toThrow(RangeError);
    expect(() => toPoints(Number.NaN, EURUSD)).toThrow(RangeError);
  });

  it("the classic float trap: 0.1 + 0.2 and 0.3 are the same number of points", () => {
    expect(0.1 + 0.2 === 0.3).toBe(false);
    expect(toPoints(0.1 + 0.2, EURUSD)).toBe(toPoints(0.3, EURUSD));
    expect(pricesEqual(roundToTick(0.1 + 0.2, EURUSD), roundToTick(0.3, EURUSD), EURUSD)).toBe(true);
  });

  it("a real FX case: 1.0861 + 11 pips is 1.0872 in points, although the float is 1.0872000000000002", () => {
    const moved = 1.0861 + 0.0011;
    expect(moved === 1.0872).toBe(false);
    expect(toPoints(moved, EURUSD)).toBe(toPoints(1.0872, EURUSD));
    expect(comparePrices(roundToTick(moved, EURUSD), roundToTick(1.0872, EURUSD), EURUSD)).toBe(0);
  });

  it("converts known values exactly", () => {
    expect(toPoints(1.0861, EURUSD)).toBe(108610);
    expect(fromPoints(points(108610), EURUSD)).toBe(1.0861);
    expect(toPoints(154.321, USDJPY)).toBe(154321);
    expect(toPoints(2650.55, XAUUSD)).toBe(265055);
  });

  it.each(ALL_SPECS)("$symbol: fromPoints ∘ toPoints is the identity on integers", (spec) => {
    const [min, max] = RANGE[spec.symbol]!;
    fc.assert(
      fc.property(
        fc.integer({ min: Math.round(min / spec.point), max: Math.round(max / spec.point) }),
        (n) => {
          expect(toPoints(fromPoints(points(n), spec), spec)).toBe(n);
        },
      ),
    );
  });
});

describe("§0 roundToTick", () => {
  it("tickPoints is tickSize in points, at least 1", () => {
    expect(tickPoints(EURUSD)).toBe(1);
    expect(tickPoints(US30)).toBe(25);
    expect(tickPoints({ ...EURUSD, tickSize: 0.000001 })).toBe(1);
  });

  it("rounds an index price to the nearest quarter", () => {
    expect(roundToTick(42000.12, US30)).toBe(42000);
    expect(roundToTick(42000.13, US30)).toBe(42000.25);
    expect(roundToTick(42000.37, US30)).toBe(42000.25);
    expect(roundToTick(42000.38, US30)).toBe(42000.5);
  });

  it("rounds to digits on FX", () => {
    expect(roundToTick(1.086104, EURUSD)).toBe(1.0861);
    expect(roundToTick(1.086106, EURUSD)).toBe(1.08611);
  });

  it.each(ALL_SPECS)("$symbol: idempotent", (spec) => {
    fc.assert(
      fc.property(priceFor(spec), (x) => {
        const once = roundToTick(x, spec);
        expect(roundToTick(once, spec)).toBe(once);
      }),
    );
  });

  it.each(ALL_SPECS)("$symbol: result is on the tick grid and within half a tick", (spec) => {
    fc.assert(
      fc.property(priceFor(spec), (x) => {
        const pts = roundToTickPoints(x, spec);
        expect(pts % tickPoints(spec)).toBe(0);
        expect(Math.abs(fromPoints(pts, spec) - x)).toBeLessThanOrEqual(spec.tickSize / 2 + spec.point);
      }),
    );
  });

  it.each(ALL_SPECS)("$symbol: never has more decimals than digits", (spec) => {
    fc.assert(
      fc.property(priceFor(spec), (x) => {
        const s = formatPrice(roundToTick(x, spec), spec);
        expect(Number(s)).toBe(roundToTick(x, spec));
        expect(s.split(".")[1]?.length ?? 0).toBe(spec.digits);
      }),
    );
  });
});

describe("§0 comparePrices", () => {
  it("orders prices by points", () => {
    const a = roundToTick(1.0861, EURUSD);
    const b = roundToTick(1.08611, EURUSD);
    expect(comparePrices(a, b, EURUSD)).toBe(-1);
    expect(comparePrices(b, a, EURUSD)).toBe(1);
    expect(comparePrices(a, a, EURUSD)).toBe(0);
  });

  it.each(ALL_SPECS)("$symbol: float noise far below a point never flips a comparison", (spec) => {
    fc.assert(
      fc.property(priceFor(spec), fc.double({ min: -1e-9, max: 1e-9, noNaN: true }), (x, noise) => {
        const p = roundToTick(x, spec);
        const noisy = (p + noise * spec.point) as typeof p;
        expect(comparePrices(noisy, p, spec)).toBe(0);
      }),
    );
  });

  it.each(ALL_SPECS)("$symbol: agrees with exact integer comparison", (spec) => {
    fc.assert(
      fc.property(priceFor(spec), priceFor(spec), (x, y) => {
        const a = roundToTick(x, spec);
        const b = roundToTick(y, spec);
        expect(comparePrices(a, b, spec)).toBe(Math.sign(toPoints(a, spec) - toPoints(b, spec)));
      }),
    );
  });
});

describe("R0.1 specProblems", () => {
  it.each(ALL_SPECS)("$symbol fixture is valid", (spec) => {
    expect(specProblems(spec)).toEqual([]);
  });

  it.each<[string, Partial<SymbolSpec>, string]>([
    ["digits not integer", { digits: 4.5 }, "digits must be an integer 0..10"],
    ["digits too big", { digits: 11 }, "digits must be an integer 0..10"],
    ["point zero", { point: 0 }, "point must be > 0"],
    ["point NaN", { point: Number.NaN }, "point must be > 0"],
    ["point vs digits", { point: 0.0001 }, "point must equal 10^-digits"],
    ["tick zero", { tickSize: 0 }, "tickSize must be > 0"],
    ["tick below point", { tickSize: 0.000005 }, "tickSize must be a whole multiple of point"],
    ["tick off-grid", { tickSize: 0.000015 }, "tickSize must be a whole multiple of point"],
    ["stops negative", { stopsLevel: -1 }, "stopsLevel must be an integer ≥ 0"],
    ["freeze fractional", { freezeLevel: 1.5 }, "freezeLevel must be an integer ≥ 0"],
    ["volumeMin zero", { volumeMin: 0 }, "volumeMin must be > 0"],
    ["volumeStep zero", { volumeStep: 0 }, "volumeStep must be > 0"],
    ["volumeMax below min", { volumeMax: 0.001 }, "volumeMax must be ≥ volumeMin"],
    ["volumeMax NaN", { volumeMax: Number.NaN }, "volumeMax must be ≥ volumeMin"],
  ])("rejects %s", (_name, patch, problem) => {
    expect(specProblems({ ...EURUSD, ...patch })).toContain(problem);
  });

  it("reports point problems without a digits cross-check when digits is broken", () => {
    expect(specProblems({ ...EURUSD, digits: 2.5, point: 0.01, tickSize: 0.01 })).toEqual([
      "digits must be an integer 0..10",
    ]);
  });

  it("skips the tick/point ratio check when point itself is broken", () => {
    expect(specProblems({ ...EURUSD, point: 0 })).toEqual(["point must be > 0"]);
  });
});
