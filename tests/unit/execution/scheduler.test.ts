import { describe, expect, it } from "vitest";
import { realScheduler, VirtualScheduler } from "@/execution/scheduler";

describe("VirtualScheduler", () => {
  it("advances time only to fire timers, in order", async () => {
    const s = new VirtualScheduler(1000);
    const seen: [string, number][] = [];
    const work = Promise.all([
      s.sleep(300).then(() => seen.push(["b", s.now()])),
      s.sleep(100).then(() => seen.push(["a", s.now()])),
      s.sleep(100).then(() => seen.push(["a2", s.now()])),
    ]);
    await s.run(work);
    expect(seen).toEqual([
      ["a", 1100],
      ["a2", 1100],
      ["b", 1300],
    ]);
    expect(s.now()).toBe(1300);
    expect(s.pendingTimers).toBe(0);
  });

  it("follows chained sleeps and returns the result", async () => {
    const s = new VirtualScheduler();
    const work = (async () => {
      await s.sleep(10);
      await s.sleep(20);
      return s.now();
    })();
    expect(await s.run(work)).toBe(30);
  });

  it("propagates errors and detects deadlocks", async () => {
    const s = new VirtualScheduler();
    await expect(s.run(s.sleep(5).then(() => Promise.reject(new Error("boom"))))).rejects.toThrow("boom");
    await expect(s.run(new Promise(() => undefined))).rejects.toThrow(/stuck/);
    await expect(s.run(Promise.reject(new Error("plain")))).rejects.toThrow("plain");
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejections on purpose
    await expect(s.run(Promise.reject("str"))).rejects.toThrow("str");
  });

  it("stops at the step limit", async () => {
    const s = new VirtualScheduler();
    const forever = (async () => {
      for (;;) await s.sleep(1);
    })();
    await expect(s.run(forever, 5)).rejects.toThrow(/step limit/);
  });

  it("negative sleeps fire immediately", async () => {
    const s = new VirtualScheduler(50);
    await s.run(s.sleep(-10));
    expect(s.now()).toBe(50);
  });
});

describe("realScheduler", () => {
  it("reads the wall clock and really waits", async () => {
    const t0 = realScheduler.now();
    await realScheduler.sleep(5);
    expect(realScheduler.now() - t0).toBeGreaterThanOrEqual(4);
    await realScheduler.sleep(-1);
  });
});
