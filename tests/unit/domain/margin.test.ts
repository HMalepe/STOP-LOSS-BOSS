import { describe, expect, it } from "vitest";
import { marginVerdict, netMargin } from "@/domain/margin";

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
