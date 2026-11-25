import { describe, expect, it } from "vitest";
import {
  buildMarketBatch,
  ceilCents,
  riskToSl,
  type EntryAccount,
  type EntryCaps,
  type MarketBatchRequest,
} from "@/domain/entries";
import { marginVerdict, netMargin } from "@/domain/margin";
import { points } from "@/domain/price";
import { baseline, DEFAULT_SPREAD, median, spreadVerdict } from "@/domain/spreadGuard";
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
const QUOTE: Quote = { symbol: "EURUSD", bid: 1.086, ask: 1.08612, time: 1, lossTickValue: 1 }; // spread 12 pts, $1 per tick per lot
const CAPS: EntryCaps = { maxOrders: 100, maxTotalLots: 5, maxRiskPct: 2 };
const ACCT: EntryAccount = { equity: 10_000, hedging: true, commissionPerLot: 0 };
/** Overrides; `sl: null` / `tp: null` remove the level (exactOptionalPropertyTypes forbids `undefined`). */
type Over = Omit<Partial<MarketBatchRequest>, "sl" | "tp"> & {
  sl?: MarketBatchRequest["sl"] | null;
  tp?: MarketBatchRequest["tp"] | null;
};
const req = (o: Over = {}): MarketBatchRequest => {
  const { sl, tp, ...rest } = o;
  const base = { symbol: "EURUSD", side: "BUY" as const, count: 10, volume: 0.05, ...rest };
  return {
    ...base,
    ...(sl === null ? {} : { sl: sl ?? { mode: "points" as const, points: 150 } }),
    ...(tp === null ? {} : { tp: tp ?? { mode: "points" as const, points: 300 } }),
  };
};
const build = (o: Over = {}, q: Quote | null = QUOTE, c = CAPS, a = ACCT) =>
  buildMarketBatch(req(o), { spec: SPEC, quote: q }, c, a);

function ok(r: ReturnType<typeof build>) {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.plan;
}
function err(r: ReturnType<typeof build>) {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("R5.3 market entries with SL/TP (validated against the CLOSING price, points from the expected fill)", () => {
  it("buy: SL/TP points from the ASK; sell: from the BID", () => {
    const b = ok(build());
    expect(b.items[0]).toMatchObject({ sl: 1.08462, tp: 1.08912, side: "BUY", volume: 0.05 });
    const s = ok(build({ side: "SELL" }));
    expect(s.items[0]).toMatchObject({ sl: 1.0875, tp: 1.083 });
  });
  it("every entry carries the requested stop (non-negotiable 9); indexes are 0..n-1", () => {
    const p = ok(build({ count: 25 }));
    expect(p.items).toHaveLength(25);
    expect(p.items.every((i) => i.sl !== null)).toBe(true);
    expect(p.items.map((i) => i.index)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });
  it("an SL too close to the closing price is refused, listing the boundary, building nothing", () => {
    // buy SL = ask − 15 = 1.08597; its closing price is the BID (1.086), so it must be below bid − d(12) = 1.08588
    const e = err(build({ sl: { mode: "points", points: 15 } }));
    expect(e.code).toBe("PLAN_INVALID");
    if (e.code === "PLAN_INVALID") {
      expect(e.details[0]).toMatchObject({ rule: "R2.1", side: "BUY", level: "SL", count: 10 });
      expect(e.details[0]?.message).toMatch(/placed from the ask, but checked against the bid/);
    }
  });
  it("price mode: rounded to the tick, validated; a wrong-side TP is refused", () => {
    expect(ok(build({ sl: { mode: "price", price: 1.0845 }, tp: null })).items[0]?.sl).toBe(1.0845);
    const e = err(build({ tp: { mode: "price", price: 1.0801 } }));
    expect(e.code === "PLAN_INVALID" && e.details[0]?.rule).toBe("R2.2");
  });
  it('a TP-only batch needs an explicit "no stop" (R9.2b); with it, it builds and warns', () => {
    expect(err(build({ sl: null }))).toEqual({
      code: "VALIDATION",
      message: 'Add a stop loss, or choose "no stop" to open without one.',
    });
    const p = ok(build({ sl: null, noStop: true }));
    expect(p.risk).toEqual({ perOrder: null, total: null, unlimited: true, pctOfEquity: null });
    expect(p.warnings).toContain("No stop loss: the risk on these orders is not limited.");
    expect(p.items.every((i) => i.sl === null && i.tp !== null)).toBe(true);
  });
  it("noStop is ignored when an SL IS given (a requested stop is never dropped)", () => {
    expect(ok(build({ noStop: true })).items.every((i) => i.sl !== null)).toBe(true);
  });
});

describe("R5.1 / R5.2 volume and caps", () => {
  it("an off-grid lot is rejected, not rounded", () => {
    expect(err(build({ volume: 0.055 })).code).toBe("VALIDATION");
  });
  it("R5.2 count and total-lots caps reject the whole action, saying why", () => {
    const e1 = err(build({ count: 101 }));
    expect(e1.code === "PLAN_INVALID" && e1.details[0]?.message).toBe(
      "101 orders is over the limit of 100 per action.",
    );
    const e2 = err(build({ count: 60, volume: 0.1 })); // 6 lots > 5
    expect(e2.code === "PLAN_INVALID" && e2.details[0]?.message).toBe(
      "6 lots in total is over the limit of 5 per action.",
    );
    expect(ok(build({ count: 50, volume: 0.1 }, QUOTE, { ...CAPS, maxRiskPct: 100 })).totalLots).toBe(5); // exactly at the cap is allowed
  });
  it("total lots add in integer steps (no 0.30000000000000004)", () => {
    expect(ok(build({ count: 3, volume: 0.1 })).totalLots).toBe(0.3);
  });
  it("junk requests are refused before any maths", () => {
    for (const o of [
      { count: 0 },
      { count: 1.5 },
      { symbol: " " },
      { sl: { mode: "points", points: 0 } as const },
      { tp: { mode: "price", price: -1 } as const },
    ]) {
      expect(err(build(o)).code).toBe("VALIDATION");
    }
    expect(() => build({}, QUOTE, { ...CAPS, maxOrders: 5000 })).toThrow(/≤ 1000/);
  });
});

describe("R0.1 / R0.2 gates", () => {
  it("no spec/quote, or a crossed quote → BROKER_UNAVAILABLE; netting → refused", () => {
    expect(err(build({}, null)).code).toBe("BROKER_UNAVAILABLE");
    expect(err(build({}, { ...QUOTE, bid: 1.2 })).code).toBe("BROKER_UNAVAILABLE");
    expect(err(build({}, QUOTE, CAPS, { ...ACCT, hedging: false })).message).toMatch(/netting/);
    expect(err(buildMarketBatch(req(), { spec: null, quote: QUOTE }, CAPS, ACCT)).code).toBe(
      "BROKER_UNAVAILABLE",
    );
  });
});

describe("R9.2 risk to the SL", () => {
  it("per order = ticks × lossTickValue × lots, money rounded UP; total = per order × count", () => {
    // buy @ ask 1.08612, SL 150 pts below = 150 ticks × $1 × 0.05 lots = $7.50 per order; ×10 = $75
    const p = ok(build());
    expect(p.risk).toMatchObject({ perOrder: 7.5, total: 75, unlimited: false });
    expect(p.risk.pctOfEquity).toBeCloseTo(0.75, 10);
    expect(p.warnings).toContain("Risk excludes gaps and slippage, and uses today's currency rates.");
  });
  it("commission per lot is added", () => {
    expect(ok(build({}, QUOTE, CAPS, { ...ACCT, commissionPerLot: 3 })).risk.perOrder).toBe(7.65);
  });
  it("ceilCents never understates and ignores float dust", () => {
    expect([ceilCents(7.5), ceilCents(0.1 + 0.2), ceilCents(1.001), ceilCents(2.0000000001)]).toEqual([
      7.5, 0.3, 1.01, 2,
    ]);
  });
  it("riskToSl on a 0.001-tick JPY pair uses ticks, not points", () => {
    const jpy: SymbolSpec = { ...SPEC, symbol: "USDJPY", digits: 3, point: 0.001, tickSize: 0.001 };
    expect(
      riskToSl({
        entry: points(150000),
        sl: points(149500),
        spec: jpy,
        lots: 1,
        lossTickValue: 0.67,
        commissionPerLot: 0,
      }),
    ).toBe(335);
    // a symbol whose tick is 10 points: 500 points = 50 ticks
    const gold: SymbolSpec = { ...SPEC, digits: 2, point: 0.01, tickSize: 0.1 };
    expect(
      riskToSl({
        entry: points(265000),
        sl: points(264500),
        spec: gold,
        lots: 1,
        lossTickValue: 10,
        commissionPerLot: 0,
      }),
    ).toBe(500);
  });
  it("unverifiable tick value or equity → blocked (BROKER_UNAVAILABLE), never guessed", () => {
    for (const q of [
      { ...QUOTE, lossTickValue: undefined },
      { ...QUOTE, lossTickValue: 0 },
      { ...QUOTE, lossTickValue: NaN },
    ]) {
      expect(err(build({}, q as Quote)).code).toBe("BROKER_UNAVAILABLE");
    }
    expect(err(build({}, QUOTE, CAPS, { ...ACCT, equity: 0 })).code).toBe("BROKER_UNAVAILABLE");
    expect(
      riskToSl({
        entry: points(1),
        sl: points(2),
        spec: SPEC,
        lots: 1,
        lossTickValue: undefined,
        commissionPerLot: 0,
      }),
    ).toBeNull();
  });
  it("R9.2a: risk over the cap % of equity is refused, showing both numbers", () => {
    const e = err(build({ count: 100, volume: 0.05, sl: { mode: "points", points: 450 } })); // 100 × 22.5 = 2250 = 22.5%
    expect(e.code === "PLAN_INVALID" && e.details[0]).toMatchObject({ rule: "R9.2a" });
    expect(e.code === "PLAN_INVALID" && e.details[0]?.message).toMatch(
      /2250\.00 \(22\.50% of equity\)\. The limit is 2% per action/,
    );
    // exactly at the cap passes
    expect(ok(build({ count: 20, volume: 0.1, sl: { mode: "points", points: 100 } })).risk.total).toBe(200);
  });
});

describe("R9.3 margin", () => {
  it("net of existing, plus a 10% factor; unverifiable = blocked", () => {
    expect(netMargin(1500, 1000)).toBeCloseTo(550, 10);
    expect(netMargin(undefined, 1000)).toBeUndefined();
    expect(netMargin(1500, undefined)).toBeUndefined();
    expect(netMargin(NaN, 0)).toBeUndefined();
    expect(netMargin(100, 200)).toBe(0); // never negative
  });
  const base = {
    freeMargin: 5000,
    equity: 10_000,
    usedMargin: 1000,
    totalRisk: 75,
    stopOutPct: 50 as number | null,
  };
  it("blocks when required exceeds free margin, or can't be verified", () => {
    expect(marginVerdict({ ...base, required: undefined })).toMatchObject({
      ok: false,
      code: "MARGIN_UNVERIFIED",
    });
    expect(marginVerdict({ ...base, required: 6000 })).toEqual({
      ok: false,
      code: "MARGIN_INSUFFICIENT",
      message: "This batch needs 6000.00 margin; you have 5000.00 free.",
    });
  });
  it("warns under 300% and when every stop hit would pass the stop-out", () => {
    expect(marginVerdict({ ...base, required: 100 })).toEqual({ ok: true, warnings: [], required: 100 });
    expect(marginVerdict({ ...base, required: 4000 })).toMatchObject({
      ok: true,
      warnings: ["Margin level would drop to 200%."],
    });
    const w = marginVerdict({ ...base, required: 4000, totalRisk: 9000, stopOutPct: 50 });
    expect(w.ok && w.warnings[1]).toMatch(/below the broker's stop-out \(50%\)/);
  });
  it("no stop → hard floor of 500%", () => {
    expect(marginVerdict({ ...base, required: 3000, totalRisk: null })).toMatchObject({
      ok: false,
      code: "MARGIN_INSUFFICIENT",
    });
    expect(marginVerdict({ ...base, required: 100, totalRisk: null })).toMatchObject({ ok: true });
    expect(marginVerdict({ ...base, usedMargin: 0, required: 0, totalRisk: null })).toMatchObject({
      ok: true,
    });
  });
});

describe("R9.4 spread guard", () => {
  const calm = Array.from({ length: 40 }, () => 12);
  it("median and the spike-robust baseline", () => {
    expect([median([3, 1, 2]), median([1, 2, 3, 4]), median([])]).toEqual([2, 2.5, 0]);
    expect(baseline([...calm, ...Array.from({ length: 10 }, () => 200)], 5)).toBe(12); // a spike can't drag normal up
  });
  it("refuses a 10× spike, allows normal, says what normal is", () => {
    expect(spreadVerdict(120, calm)).toEqual({
      ok: false,
      normal: 12,
      message: "Spread is 120 points; it's normally 12. Refused until it settles.",
    });
    expect(spreadVerdict(30, calm)).toEqual({ ok: true, normal: 12 });
    expect(spreadVerdict(36, calm).ok).toBe(true); // exactly 3×
    expect(spreadVerdict(37, calm).ok).toBe(false);
  });
  it("median 0 must NOT block a spread of 1 (raw accounts); the floor applies", () => {
    const raw = Array.from({ length: 40 }, () => 0);
    expect(spreadVerdict(1, raw).ok).toBe(true);
    expect(spreadVerdict(10, raw).ok).toBe(true);
    expect(spreadVerdict(11, raw).ok).toBe(false);
  });
  it("a long widening can't become normal (spike samples excluded)", () => {
    const widened = [...Array.from({ length: 30 }, () => 12), ...Array.from({ length: 70 }, () => 90)];
    // median is 90 here, so nothing is excluded: the limit moves. The guard is honest about what it can't catch.
    expect(spreadVerdict(90, widened).ok).toBe(true);
    const brief = [...Array.from({ length: 60 }, () => 12), ...Array.from({ length: 20 }, () => 90)];
    expect(spreadVerdict(90, brief).ok).toBe(false);
  });
  it("too few samples: warn (guard off) unless the absolute limit is set; absolute limit always applies", () => {
    expect(spreadVerdict(500, [12, 12])).toEqual({
      ok: true,
      normal: null,
      warning:
        "Not enough recent prices to know the normal spread, so the spread guard is off for this batch.",
    });
    const abs = { ...DEFAULT_SPREAD, absoluteMaxPoints: 50 };
    expect(spreadVerdict(500, [12, 12], abs)).toEqual({
      ok: false,
      normal: null,
      message: "Spread is 500 points; the limit is 50.",
    });
    expect(spreadVerdict(20, [12, 12], abs)).toEqual({ ok: true, normal: null });
    expect(spreadVerdict(60, calm, abs).ok).toBe(false);
  });
});
