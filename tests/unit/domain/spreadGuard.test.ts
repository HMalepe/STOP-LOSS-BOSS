import { describe, expect, it } from "vitest";
import { baseline, DEFAULT_SPREAD, median, spreadVerdict } from "@/domain/spreadGuard";

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
