import { describe, expect, it } from "vitest";
import { SpreadSampler } from "@/server/trading/spread";

const spec = { point: 0.00001, digits: 5, tickSize: 0.00001 };
const q = (time: number, bid = 1.086, ask = 1.08612, symbol = "EURUSD") => ({ symbol, bid, ask, time });

describe("R9.4b spread samples", () => {
  it("records integer points, once per NEW tick (the same quote twice counts once)", () => {
    const s = new SpreadSampler(300);
    s.record(q(1), spec, 1_000);
    s.record(q(1), spec, 2_000);
    s.record(q(2, 1.086, 1.08615), spec, 3_000);
    expect(s.samples("EURUSD", 3_000)).toEqual([12, 15]);
    expect(SpreadSampler.points({ bid: 1.0861, ask: 1.0862 }, spec)).toBe(10); // no float dust: 1.0862 − 1.0861
  });
  it("forgets samples older than the window", () => {
    const s = new SpreadSampler(10);
    s.record(q(1), spec, 0);
    s.record(q(2), spec, 9_000);
    expect(s.samples("EURUSD", 9_500)).toEqual([12, 12]);
    expect(s.samples("EURUSD", 12_000)).toEqual([12]);
    expect(s.samples("EURUSD", 100_000)).toEqual([]);
  });
  it("ignores crossed or empty quotes; symbols are independent; unknown symbol is empty; memory is bounded", () => {
    const s = new SpreadSampler(300, 3);
    s.record(q(1, 1.2, 1.1), spec, 0);
    s.record(q(2, 0, 0), spec, 0);
    expect(s.samples("EURUSD", 0)).toEqual([]);
    for (let i = 0; i < 10; i++) s.record(q(i + 10), spec, i);
    s.record(q(1, 100, 100.05, "XAUUSD"), spec, 0);
    expect(s.samples("EURUSD", 20)).toHaveLength(3);
    expect(s.samples("XAUUSD", 20)).toEqual([5000]);
    expect(s.samples("NOPE", 0)).toEqual([]);
  });
});
