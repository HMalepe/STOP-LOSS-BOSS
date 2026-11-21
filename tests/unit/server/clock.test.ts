import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "@/server/clock";

describe("systemClock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the real wall clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_763_769_600_000);
    expect(systemClock.now()).toBe(1_763_769_600_000);
  });
});
