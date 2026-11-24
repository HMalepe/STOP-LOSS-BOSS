import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "@/domain/clock";
import type { Quote } from "@/domain/types";
import { SpreadMonitor } from "@/server/trading/spreadMonitor";

const SPEC = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 0,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
};
const q = (time: number, spreadPts = 10): Quote => ({
  symbol: "EURUSD",
  bid: 1.086,
  ask: 1.086 + spreadPts * 0.00001,
  time,
});

function setup() {
  const clock = new ManualClock(1_000_000);
  const timers: { fn: () => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const m = new SpreadMonitor({
    windowMs: 300_000,
    clock,
    every: (_ms, fn) => {
      const stop = vi.fn();
      timers.push({ fn, stop });
      return stop;
    },
  });
  return { clock, m, timers };
}

describe("spread samples for R9.4b", () => {
  it("records spread in points per tick; the same tick twice counts once", () => {
    const { m, clock } = setup();
    const t = clock.now();
    m.record(q(t - 2, 12), SPEC);
    m.record(q(t - 2, 12), SPEC);
    m.record(q(t - 1, 8), SPEC);
    expect(m.samples("EURUSD")).toEqual([12, 8]);
  });

  it("only the window counts; older ticks fall out", () => {
    const { m, clock } = setup();
    m.record(q(clock.now() - 400_000), SPEC);
    m.record(q(clock.now() - 100_000, 20), SPEC);
    expect(m.samples("EURUSD")).toEqual([20]);
    clock.advance(250_000);
    expect(m.samples("EURUSD")).toEqual([]);
  });

  it("bounded memory: per symbol and in number of symbols", () => {
    const { m } = setup();
    for (let i = 0; i < 6_000; i++) m.record(q(1_000_000 - 6_000 + i), SPEC);
    expect(m.samples("EURUSD").length).toBe(5_000);
    for (let i = 0; i < 30; i++) {
      m.record({ ...q(1), symbol: `S${String(i)}` }, { ...SPEC, symbol: `S${String(i)}` });
    }
    expect(m.size).toBeLessThanOrEqual(20);
  });

  it("watch polls a symbol once (not twice for two calls), and stops after 10 idle minutes", async () => {
    const { m, timers, clock } = setup();
    let t = clock.now();
    const read = vi.fn(() => Promise.resolve({ quote: q(++t), spec: SPEC }));
    m.watch("EURUSD", read);
    m.watch("EURUSD", read);
    expect(timers).toHaveLength(1);
    timers[0]?.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(m.samples("EURUSD")).toHaveLength(1);
    clock.advance(600_001);
    timers[0]?.fn();
    expect(timers[0]?.stop).toHaveBeenCalled();
  });

  it("a failing read is ignored (the guard just sees fewer ticks)", async () => {
    const { m, timers } = setup();
    m.watch("EURUSD", () => Promise.reject(new Error("down")));
    timers[0]?.fn();
    await Promise.resolve();
    expect(m.samples("EURUSD")).toEqual([]);
  });
});
