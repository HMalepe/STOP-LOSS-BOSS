import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  countdown,
  nudge,
  parsePrice,
  planSentence,
  progressHeadline,
  signedMoney,
  spreadPoints,
} from "@/ui/logic";

describe("price input", () => {
  it("parses positive prices, commas too; rejects junk", () => {
    expect(parsePrice("1.08611")).toBe(1.08611);
    expect(parsePrice(" 2650,1 ")).toBe(2650.1);
    for (const bad of ["", "0", "-1", "1e3", "abc", "1.2.3", "."]) expect(parsePrice(bad)).toBeNull();
  });

  it("nudges in integer points: no float dust, never ≤ 0, junk unchanged", () => {
    expect(nudge("1.08611", 1, 5)).toBe("1.08612");
    expect(nudge("1.1", 20000, 5)).toBe("1.30000");
    expect(nudge("2650.10", -10, 2)).toBe("2650.00");
    expect(nudge("0.00001", -1, 5)).toBe("0.00001");
    expect(nudge("abc", 1, 5)).toBe("abc");
  });

  it("property: +n then −n returns the same price (to the digit grid)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 5 }),
        (pts, n, digits) => {
          const start = (pts / 10 ** digits).toFixed(digits);
          const there = nudge(start, n, digits);
          if (there === start && n !== 0) return; // would go ≤ 0: refused
          expect(nudge(there, -n, digits)).toBe(start);
        },
      ),
    );
  });

  it("spread in points; signed money with a real minus", () => {
    expect(spreadPoints(1.08601, 1.08611, 5)).toBe(10);
    expect(spreadPoints(2650.1, 2650.3, 2)).toBe(20);
    expect([signedMoney(1234.5), signedMoney(-51), signedMoney(0)]).toEqual(["+1,234.50", "−51.00", "0.00"]);
  });
});

describe("countdown", () => {
  const at = Date.parse("2026-11-23T10:00:30Z");
  it("seconds round up, fraction of 30 s, expired at zero", () => {
    expect(countdown("2026-11-23T10:00:30Z", at - 29_500)).toEqual({
      seconds: 30,
      fraction: 29_500 / 30_000,
      expired: false,
    });
    expect(countdown("2026-11-23T10:00:30Z", at - 1)).toMatchObject({ seconds: 1, expired: false });
    expect(countdown("2026-11-23T10:00:30Z", at)).toEqual({ seconds: 0, fraction: 0, expired: true });
    expect(countdown("garbage", at)).toMatchObject({ expired: true });
    expect(countdown("2026-11-23T10:01:30Z", at).fraction).toBe(1);
  });
});

describe("plain sentences (07-UI-SPEC #7)", () => {
  const s = (over: object = {}) => ({
    action: "closeAt" as const,
    symbol: "EURUSD",
    count: 214,
    breakdown: { buys: 120, sells: 94, asTP: 180, asSL: 34 },
    ...over,
  });
  it("close-at splits TP/SL", () => {
    expect(planSentence(s(), { action: "closeAt", price: "1.09000" })).toBe(
      "214 EURUSD positions will close at 1.09000. 180 as take profit, 34 as stop loss.",
    );
    expect(
      planSentence(s({ count: 1, breakdown: { buys: 1, sells: 0, asTP: 1 } }), {
        action: "closeAt",
        price: "1.1",
      }),
    ).toBe("1 EURUSD position will close at 1.1. 1 as take profit.");
    expect(planSentence(s({ breakdown: { buys: 1, sells: 0 } }), { action: "closeAt", price: "1.1" })).toBe(
      "214 EURUSD positions will close at 1.1.",
    );
  });
  it("levels say what stays", () => {
    expect(planSentence(s(), { action: "levels", stopLoss: "1.08" })).toBe(
      "214 EURUSD positions get SL 1.08. Existing TPs stay.",
    );
    expect(planSentence(s(), { action: "levels", takeProfit: "1.1" })).toBe(
      "214 EURUSD positions get TP 1.1. Existing SLs stay.",
    );
    expect(planSentence(s(), { action: "levels", stopLoss: "1", takeProfit: "2" })).toBe(
      "214 EURUSD positions get SL 1 and TP 2.",
    );
  });
  it("helpers and close-now", () => {
    expect(planSentence(s(), { action: "breakeven", offsetPoints: 5 })).toBe(
      "214 EURUSD positions move their SL to entry +5 points.",
    );
    expect(planSentence(s(), { action: "breakeven", offsetPoints: 0 })).toBe(
      "214 EURUSD positions move their SL to entry.",
    );
    expect(planSentence(s(), { action: "lock", distancePoints: 100 })).toBe(
      "214 EURUSD positions lock profit with an SL 100 points behind price.",
    );
    expect(planSentence(s({ breakdown: { buys: 1, sells: 1, cancels: 3 } }), { action: "close" })).toBe(
      "214 EURUSD positions close now at market, and 3 pending orders cancel.",
    );
    expect(planSentence(s({ breakdown: { buys: 1, sells: 1 } }), { action: "close" })).toBe(
      "214 EURUSD positions close now at market.",
    );
  });
});

describe("progress headline: never 'done' when it isn't", () => {
  const p = { total: 10, done: 10, ok: 10, failed: 0, unknown: 0, skipped: 0 };
  it("each outcome", () => {
    expect(progressHeadline({ ...p, done: 4, ok: 4 }, false)).toEqual({
      text: "Sending 4 of 10",
      tone: "neutral",
    });
    expect(progressHeadline(p, true)).toEqual({ text: "All 10 done", tone: "up" });
    expect(progressHeadline({ ...p, total: 0, done: 0, ok: 0 }, true).text).toBe("Nothing was sent");
    expect(progressHeadline({ ...p, ok: 8, failed: 2 }, true)).toEqual({
      text: "8 of 10 done · 2 failed",
      tone: "down",
    });
    expect(progressHeadline({ ...p, ok: 8, failed: 1, unknown: 1 }, true)).toEqual({
      text: "8 of 10 done · 1 failed · 1 unknown, check MT5",
      tone: "warn",
    });
    expect(progressHeadline({ ...p, ok: 7, skipped: 3 }, true)).toEqual({
      text: "7 of 10 done · 3 not sent",
      tone: "warn",
    });
  });
});
