import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { median, spreadVerdict } from "@/domain/spread";

const normal = (n: number, v = 10) => Array.from({ length: n }, () => v);

describe("R9.4 spread guard", () => {
  it("median: odd, even, unsorted; empty is null", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("R9.4b adaptive: blocks above K × the median of the window; at exactly K × passes", () => {
    expect(spreadVerdict({ spreadPts: 31, samples: normal(30), k: 3 })).toMatchObject({
      block: true,
      normalPts: 10,
    });
    expect(spreadVerdict({ spreadPts: 30, samples: normal(30), k: 3 })).toMatchObject({
      block: false,
      normalPts: 10,
    });
  });

  it("a news spike in the window doesn't drag the median (that's why median, not mean)", () => {
    const samples = [...normal(28), 500, 500];
    expect(spreadVerdict({ spreadPts: 40, samples, k: 3 })).toMatchObject({ block: true, normalPts: 10 });
  });

  it("R9.4a absolute: blocks above the per-symbol max even when the adaptive check passes", () => {
    expect(spreadVerdict({ spreadPts: 25, samples: normal(30), k: 3, maxPts: 20 })).toMatchObject({
      block: true,
    });
    expect(spreadVerdict({ spreadPts: 20, samples: normal(30), k: 3, maxPts: 20 }).block).toBe(false);
  });

  it("fewer than 30 ticks: fall back to the absolute max; if that's off too, warn and don't block", () => {
    expect(spreadVerdict({ spreadPts: 500, samples: normal(29), k: 3, maxPts: 50 })).toMatchObject({
      block: true,
    });
    const r = spreadVerdict({ spreadPts: 500, samples: normal(29), k: 3 });
    expect(r.block).toBe(false);
    expect(r.warning).toBe(
      "Spread guard can't judge yet (29 ticks seen, needs 30). Check the spread yourself.",
    );
  });

  it("the message says now vs normal, in points", () => {
    const r = spreadVerdict({ spreadPts: 45, samples: normal(30), k: 3 });
    expect(r.reason).toBe("Spread is 45 pts, normal is 10 pts (limit 3× = 30 pts). Nothing was sent.");
    expect(spreadVerdict({ spreadPts: 12, samples: normal(30), k: 3 }).summary).toBe(
      "Spread now 12 pts, normal 10 pts.",
    );
  });

  it("property: never blocks at or below the median; always blocks above K × median", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 30, maxLength: 200 }),
        fc.integer({ min: 0, max: 5_000 }),
        (samples, spreadPts) => {
          const m = median(samples) ?? 0;
          const r = spreadVerdict({ spreadPts, samples, k: 3 });
          if (spreadPts <= m) expect(r.block).toBe(false);
          if (spreadPts > 3 * m) expect(r.block).toBe(true);
        },
      ),
    );
  });
});
