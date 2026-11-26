import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EntryAccount, EntryCaps } from "@/domain/entries";
import { buildLadder, ladderLevels, plannedLevels, type LadderRequest } from "@/domain/ladder";
import { points } from "@/domain/price";
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
const QUOTE: Quote = { symbol: "EURUSD", bid: 1.086, ask: 1.08612, time: 1, lossTickValue: 1 };
const CAPS: EntryCaps = { maxOrders: 100, maxTotalLots: 50, maxRiskPct: 100 };
const ACCT: EntryAccount = { equity: 100_000, hedging: true, commissionPerLot: 0 };

const base: LadderRequest = {
  symbol: "EURUSD",
  type: "BUY_LIMIT",
  from: 1.085,
  to: 1.08,
  spacing: { kind: "levels", levels: 6 },
  lots: { kind: "flat", volume: 0.1 },
  slPoints: 200,
  tpPoints: 300,
  expiry: { type: "DAY" },
};
const build = (o: Partial<LadderRequest> = {}, q: Quote | null = QUOTE, c = CAPS, a = ACCT) =>
  buildLadder({ ...base, ...o }, { spec: SPEC, quote: q }, c, a);
function ok(r: ReturnType<typeof build>) {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.plan;
}
function err(r: ReturnType<typeof build>) {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}
const px = (p: { items: readonly { price: number }[] }) => p.items.map((i) => i.price);

describe("R5.4 ladder levels", () => {
  it("levels mode: A to B inclusive, N levels, evenly spaced, on the tick grid", () => {
    expect(px(ok(build()))).toEqual([1.085, 1.084, 1.083, 1.082, 1.081, 1.08]);
  });
  it("N = 1 → a single level at A", () => {
    expect(px(ok(build({ spacing: { kind: "levels", levels: 1 } })))).toEqual([1.085]);
  });
  it("rounding to the tick can collide: duplicates are removed and REPORTED", () => {
    const wide: SymbolSpec = { ...SPEC, tickSize: 0.0001 }; // tick = 10 points
    const r = buildLadder(
      { ...base, from: 1.085, to: 1.0852, spacing: { kind: "levels", levels: 6 } },
      { spec: wide, quote: QUOTE },
      CAPS,
      ACCT,
    );
    const p = ok(r);
    expect(p.requestedLevels).toBe(6);
    expect(p.items.length).toBeLessThan(6);
    expect(new Set(px(p)).size).toBe(p.items.length);
    expect(p.duplicatesRemoved).toBe(6 - p.items.length);
    expect(p.warnings.some((w) => w.includes("landed on the same price after rounding"))).toBe(true);
  });
  it("from = to with many levels collapses to one level, reported", () => {
    const p = ok(build({ to: 1.085, spacing: { kind: "levels", levels: 5 } }));
    expect(p.items).toHaveLength(1);
    expect(p.duplicatesRemoved).toBe(4);
  });
  it("step mode: every K points from A toward B; B included only if it lands on a step", () => {
    expect(px(ok(build({ spacing: { kind: "step", stepPoints: 200 } })))).toEqual([1.085, 1.083, 1.081]); // 1.080 is 500 away: not a multiple of 200
    expect(px(ok(build({ spacing: { kind: "step", stepPoints: 250 } })))).toEqual([1.085, 1.0825, 1.08]); // lands exactly on B
    expect(
      px(ok(build({ from: 1.08, to: 1.085, type: "BUY_LIMIT", spacing: { kind: "step", stepPoints: 250 } }))),
    ).toEqual([1.08, 1.0825, 1.085]); // upward
  });
  it("step mode rejects a step that isn't a whole multiple of the tick, or isn't a positive integer", () => {
    const wide: SymbolSpec = { ...SPEC, tickSize: 0.0001 };
    const r = buildLadder(
      { ...base, spacing: { kind: "step", stepPoints: 15 } },
      { spec: wide, quote: QUOTE },
      CAPS,
      ACCT,
    );
    expect(err(r)).toEqual({
      code: "VALIDATION",
      message: "The step must be a multiple of the tick (10 points).",
    });
    for (const bad of [0, -5, 1.5, NaN]) {
      expect(err(build({ spacing: { kind: "step", stepPoints: bad } })).code).toBe("VALIDATION");
    }
    for (const bad of [0, 2.5, -1]) {
      expect(err(build({ spacing: { kind: "levels", levels: bad } })).code).toBe("VALIDATION");
    }
  });
  it("property (levels): ordered A→B, inside [A, B], unique, first = A, last = B, never more than N", () => {
    const grid = { point: 0.00001, digits: 5, tickSize: 0.00001 };
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 200_000 }),
        fc.integer({ min: 100, max: 200_000 }),
        fc.integer({ min: 1, max: 60 }),
        (a, b, n) => {
          const r = ladderLevels(points(a), points(b), { kind: "levels", levels: n }, grid);
          if (!r.ok) throw new Error(r.message);
          const L = r.levels;
          expect(L.length).toBeGreaterThanOrEqual(1);
          expect(L.length).toBeLessThanOrEqual(n);
          expect(L[0]).toBe(a);
          if (n >= 2) expect(L.at(-1)).toBe(b);
          expect(new Set(L).size).toBe(L.length);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(L.every((x) => x >= lo && x <= hi)).toBe(true);
          const dir = Math.sign(b - a);
          for (let i = 1; i < L.length; i++) expect(Math.sign((L[i] ?? 0) - (L[i - 1] ?? 0))).toBe(dir || 1);
        },
      ),
    );
  });
  it("property (step): consecutive levels are exactly K apart; B included iff (B−A) is a multiple of K", () => {
    const grid = { point: 0.00001, digits: 5, tickSize: 0.00001 };
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: 100, max: 100_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        (a, b, k) => {
          const r = ladderLevels(points(a), points(b), { kind: "step", stepPoints: k }, grid);
          if (!r.ok) throw new Error(r.message);
          const L = r.levels;
          for (let i = 1; i < L.length; i++) expect(Math.abs((L[i] ?? 0) - (L[i - 1] ?? 0))).toBe(k);
          expect(L.at(-1) === b).toBe(Math.abs(b - a) % k === 0);
          expect(L.length).toBe(Math.floor(Math.abs(b - a) / k) + 1);
          expect(plannedLevels(points(a), points(b), { kind: "step", stepPoints: k }, grid)).toBe(L.length);
        },
      ),
    );
  });
});

describe("R5.2 caps are checked from the PLAN, before anything is generated", () => {
  it("too many levels / a step that would make thousands → refused without allocating", () => {
    const e = err(build({ from: 1.2, to: 1.0, spacing: { kind: "step", stepPoints: 1 } })); // 20,001 levels
    expect(e.code === "PLAN_INVALID" && e.details[0]?.message).toBe(
      "20001 orders is over the limit of 100 per action.",
    );
    expect(err(build({ spacing: { kind: "levels", levels: 101 } })).code).toBe("PLAN_INVALID");
  });
  it("total lots cap", () => {
    const e = err(build({ lots: { kind: "flat", volume: 10 } }, QUOTE, { ...CAPS, maxTotalLots: 5 }));
    expect(e.code === "PLAN_INVALID" && e.details[0]?.message).toBe(
      "60 lots in total is over the limit of 5 per action.",
    );
  });
});

describe("R5.5 pending type vs market", () => {
  it("each type: the right side of the market, at least d away; the whole plan is refused listing the bad levels", () => {
    // ask 1.08612, d = 12 → Buy Limit must be below 1.08600
    const e = err(build({ from: 1.0865, to: 1.0855 }));
    expect(e.code).toBe("PLAN_INVALID");
    if (e.code === "PLAN_INVALID") {
      expect(e.details[0]).toMatchObject({ rule: "R5.5", side: "BUY" });
      expect(e.details[0]?.message).toMatch(
        /Buy Limit levels must be below 1\.08600 \(the ask minus 12 points\)\. \d of 6 aren't: /,
      );
    }
  });
  it("accepts valid levels for all four types", () => {
    expect(ok(build({ type: "BUY_STOP", from: 1.087, to: 1.09 })).side).toBe("BUY");
    expect(ok(build({ type: "SELL_LIMIT", from: 1.087, to: 1.09 })).side).toBe("SELL");
    expect(ok(build({ type: "SELL_STOP", from: 1.085, to: 1.08 })).items[0]?.type).toBe("SELL_STOP");
  });
  it("exactly d away is NOT enough (strict, like §2)", () => {
    expect(err(build({ from: 1.086, to: 1.086, spacing: { kind: "levels", levels: 1 } })).code).toBe(
      "PLAN_INVALID",
    ); // 1.08600 = ask − d exactly
    expect(
      ok(build({ from: 1.08599, to: 1.08599, spacing: { kind: "levels", levels: 1 } })).items,
    ).toHaveLength(1);
  });
  it("message says plus/minus the right way for each type", () => {
    const m = (type: LadderRequest["type"], from: number) => {
      const e = err(build({ type, from, to: from, spacing: { kind: "levels", levels: 1 } }));
      return e.code === "PLAN_INVALID" ? e.details[0]?.message : "";
    };
    expect(m("BUY_STOP", 1.0861)).toMatch(/the ask plus 12 points/);
    expect(m("SELL_LIMIT", 1.0861)).toMatch(/the bid plus 12 points/);
    expect(m("SELL_STOP", 1.0861)).toMatch(/the bid minus 12 points/);
  });
});

describe("R5.5b / R5.6 SL/TP on a pending: offsets from the order's OWN price, validated against it", () => {
  it("buy: SL below, TP above each level's own price", () => {
    const p = ok(build());
    expect(p.items[0]).toMatchObject({ price: 1.085, sl: 1.083, tp: 1.088 });
    expect(p.items[5]).toMatchObject({ price: 1.08, sl: 1.078, tp: 1.083 });
    const s = ok(build({ type: "SELL_LIMIT", from: 1.087, to: 1.09 }));
    expect(s.items[0]).toMatchObject({ price: 1.087, sl: 1.089, tp: 1.084 });
  });
  it("a Buy Limit with a 10-point SL when stopsLevel is 10 is rejected at plan time (needs more than d = 12)", () => {
    const e = err(build({ slPoints: 10 }));
    expect(e.code === "PLAN_INVALID" && e.details[0]).toMatchObject({ rule: "R5.5b", level: "SL", count: 6 });
    expect(err(build({ tpPoints: 12 })).code).toBe("PLAN_INVALID");
    expect(ok(build({ slPoints: 13, tpPoints: 13 })).items).toHaveLength(6);
  });
  it("a level whose stop would fall to zero is refused (R0.4)", () => {
    const e = err(
      build(
        { from: 0.0005, to: 0.0001, slPoints: 100, spacing: { kind: "levels", levels: 2 } },
        { ...QUOTE, bid: 0.01, ask: 0.01 + 0.00012 },
      ),
    );
    expect(e.code === "PLAN_INVALID" && e.details.some((d) => d.rule === "R0.4")).toBe(true);
  });
  it("junk offsets are refused", () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(err(build({ slPoints: bad })).code).toBe("VALIDATION");
  });
});

describe("R9.5 scaled lots", () => {
  it("increasing: linear start→end across the levels, each rounded DOWN to the step; total shown", () => {
    const p = ok(build({ lots: { kind: "scaled", start: 0.1, end: 0.35 } }));
    expect(p.items.map((i) => i.volume)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(p.totalLots).toBe(1.35);
  });
  it("decreasing, and a ramp that doesn't land on the grid rounds down (never up)", () => {
    expect(ok(build({ lots: { kind: "scaled", start: 0.5, end: 0.1 } })).items.map((i) => i.volume)).toEqual([
      0.5, 0.42, 0.34, 0.26, 0.18, 0.1,
    ]);
    // 0.1 → 0.2 over 4 levels: 0.1, 0.1333, 0.1667, 0.2 → 0.1, 0.13, 0.16, 0.2
    expect(
      ok(
        build({ spacing: { kind: "levels", levels: 4 }, lots: { kind: "scaled", start: 0.1, end: 0.2 } }),
      ).items.map((i) => i.volume),
    ).toEqual([0.1, 0.13, 0.16, 0.2]);
  });
  it("a ramp through the minimum: every level stays at or above it (rounding DOWN can't leave [min, max] once both ends are valid); never bumped", () => {
    const p = ok(
      build({ spacing: { kind: "levels", levels: 4 }, lots: { kind: "scaled", start: 0.01, end: 0.02 } }),
    );
    expect(p.items.map((i) => i.volume)).toEqual([0.01, 0.01, 0.01, 0.02]);
  });
  it("…unless it really lands on the minimum (0.01 → 0.02 over 2 levels is fine)", () => {
    expect(
      ok(
        build({ spacing: { kind: "levels", levels: 2 }, lots: { kind: "scaled", start: 0.01, end: 0.02 } }),
      ).items.map((i) => i.volume),
    ).toEqual([0.01, 0.02]);
  });
  it("a typed end/start must be on the grid and inside min/max; above max is refused per level", () => {
    expect(err(build({ lots: { kind: "scaled", start: 0.105, end: 0.2 } })).code).toBe("VALIDATION");
    expect(err(build({ lots: { kind: "scaled", start: 0.1, end: 0.205 } })).message).toMatch(
      /^The last lot:/,
    );
    expect(err(build({ lots: { kind: "flat", volume: 0.015 } })).code).toBe("VALIDATION");
    expect(
      err(build({ lots: { kind: "flat", volume: 99 } }, QUOTE, { ...CAPS, maxTotalLots: 1000 })).message,
    ).toMatch(/biggest lot/);
  });
  it("a single-level scaled ladder uses the first lot", () => {
    expect(
      ok(build({ spacing: { kind: "levels", levels: 1 }, lots: { kind: "scaled", start: 0.3, end: 0.9 } }))
        .items[0]?.volume,
    ).toBe(0.3);
  });
  it("property: every level's lot is on the grid, ≥ min, monotone toward `end`, and the total is the exact sum", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 2, max: 12 }),
        (s, e, n) => {
          const r = build({
            spacing: { kind: "levels", levels: n },
            from: 1.085,
            to: 1.06,
            lots: { kind: "scaled", start: s / 100, end: e / 100 },
          });
          if (!r.ok) return; // refused is a legitimate answer (below the minimum): checked elsewhere
          const v = r.plan.items.map((i) => i.volume);
          for (const x of v) {
            expect(Math.abs(x * 100 - Math.round(x * 100))).toBeLessThan(1e-9);
            expect(x).toBeGreaterThanOrEqual(0.01 - 1e-9);
          }
          for (let i = 1; i < v.length; i++) {
            expect(
              e >= s ? (v[i] ?? 0) >= (v[i - 1] ?? 0) - 1e-9 : (v[i] ?? 0) <= (v[i - 1] ?? 0) + 1e-9,
            ).toBe(true);
          }
          expect(r.plan.totalLots).toBeCloseTo(
            v.reduce((a, b) => a + b, 0),
            9,
          );
        },
      ),
    );
  });
});

describe("R9.2 risk per level; R9.2b no stop", () => {
  it("each level's risk uses ITS OWN price and lots; total and the largest single order are shown", () => {
    // 6 levels × 0.1 lots × 200 ticks × $1 = 6 × 20
    const p = ok(build());
    expect(p.risk).toMatchObject({ total: 120, largestOrder: 20, unlimited: false });
    const scaled = ok(build({ lots: { kind: "scaled", start: 0.1, end: 0.35 } }));
    expect(scaled.risk.total).toBe(270);
    expect(scaled.risk.largestOrder).toBe(70);
  });
  it("R9.2a cap vs equity", () => {
    const e = err(build({}, QUOTE, { ...CAPS, maxRiskPct: 0.1 }));
    expect(e.code === "PLAN_INVALID" && e.details[0]?.message).toBe(
      "Risk to the stops is 120.00 (0.12% of equity). The limit is 0.1% per action.",
    );
  });
  it("unverifiable tick value or equity blocks", () => {
    expect(err(build({}, { symbol: "EURUSD", bid: 1.086, ask: 1.08612, time: 1 })).code).toBe(
      "BROKER_UNAVAILABLE",
    );
    expect(err(build({}, QUOTE, CAPS, { ...ACCT, equity: 0 })).code).toBe("BROKER_UNAVAILABLE");
  });
  it("no SL needs an explicit noStop; with it the risk is unlimited and a warning says so", () => {
    const noSl: LadderRequest = { ...base };
    delete (noSl as { slPoints?: number }).slPoints;
    expect(buildLadder(noSl, { spec: SPEC, quote: QUOTE }, CAPS, ACCT)).toEqual({
      ok: false,
      error: {
        code: "VALIDATION",
        message: 'Add a stop loss, or choose "no stop" to place orders without one.',
      },
    });
    const p = ok(buildLadder({ ...noSl, noStop: true }, { spec: SPEC, quote: QUOTE }, CAPS, ACCT));
    expect(p.risk).toEqual({ total: null, largestOrder: null, unlimited: true, pctOfEquity: null });
    expect(p.items.every((i) => i.sl === null && i.tp !== null)).toBe(true);
    expect(p.warnings).toContain("No stop loss: the risk on these orders is not limited.");
  });
});

describe("R9.3 margin probe, R9.12 expiry, gates", () => {
  it("one margin probe at the HIGHEST-priced level for the total lots (an upper bound)", () => {
    expect(ok(build()).marginProbe).toEqual({ type: "BUY", price: 1.085, totalLots: 0.6 });
    expect(ok(build({ type: "SELL_STOP", from: 1.08, to: 1.07 })).marginProbe.price).toBe(1.08);
  });
  it("expiry is carried; GTC is flagged amber; a bad SPECIFIED time is refused", () => {
    expect(ok(build()).expiry).toEqual({ type: "DAY" });
    const g = ok(build({ expiry: { type: "GTC" } }));
    expect(g.warnings.some((w) => w.startsWith("Good-till-cancelled"))).toBe(true);
    expect(ok(build({ expiry: { type: "SPECIFIED", time: "2026-12-01T00:00:00Z" } })).expiry.type).toBe(
      "SPECIFIED",
    );
    expect(err(build({ expiry: { type: "SPECIFIED", time: "someday" } })).code).toBe("VALIDATION");
  });
  it("netting, missing/bad data, junk prices", () => {
    expect(err(build({}, QUOTE, CAPS, { ...ACCT, hedging: false })).message).toMatch(/netting/);
    expect(err(build({}, null)).code).toBe("BROKER_UNAVAILABLE");
    expect(err(build({}, { ...QUOTE, bid: 2 })).code).toBe("BROKER_UNAVAILABLE");
    expect(err(build({ from: -1 })).code).toBe("VALIDATION");
    expect(err(build({ from: Infinity })).code).toBe("VALIDATION");
    expect(err(build({ symbol: " " })).code).toBe("VALIDATION");
    expect(err(buildLadder(base, { spec: null, quote: QUOTE }, CAPS, ACCT)).code).toBe("BROKER_UNAVAILABLE");
  });
  it("indexes run 0..n-1 in price order; every item carries its own stop (non-negotiable 9)", () => {
    const p = ok(build());
    expect(p.items.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(p.items.every((i) => i.sl !== null)).toBe(true);
  });
});
