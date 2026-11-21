import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ManualClock } from "@/domain/clock";

describe("ManualClock", () => {
  it("starts at the given time and defaults to 0", () => {
    expect(new ManualClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
    expect(new ManualClock().now()).toBe(0);
  });

  it("only moves when advanced", () => {
    const clock = new ManualClock(10);
    expect(clock.now()).toBe(10);
    expect(clock.now()).toBe(10);
    clock.advance(250);
    expect(clock.now()).toBe(260);
  });

  it("is monotonic for any sequence of non-negative advances", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 })), (steps) => {
        const clock = new ManualClock();
        let last = clock.now();
        for (const step of steps) {
          clock.advance(step);
          expect(clock.now()).toBeGreaterThanOrEqual(last);
          last = clock.now();
        }
        expect(last).toBe(steps.reduce((a, b) => a + b, 0));
      }),
    );
  });

  it("refuses to go backwards or take non-finite input", () => {
    const clock = new ManualClock();
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
    expect(() => new ManualClock(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
