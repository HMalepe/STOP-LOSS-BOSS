import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CreditLimiter } from "@/execution/rateLimiter";
import { VirtualScheduler } from "@/execution/scheduler";

const make = (over: Partial<ConstructorParameters<typeof CreditLimiter>[0]> = {}) => {
  const scheduler = new VirtualScheduler();
  const limiter = new CreditLimiter({
    capacity: 100,
    windowMs: 1000,
    safety: 1,
    maxInFlight: 3,
    scheduler,
    ...over,
  });
  return { scheduler, limiter };
};

describe("CreditLimiter basics", () => {
  it("uses 90% of capacity by default (headroom)", () => {
    const scheduler = new VirtualScheduler();
    expect(new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler }).budget).toBe(
      4500,
    );
  });

  it("refuses bad options and impossible costs", async () => {
    const scheduler = new VirtualScheduler();
    expect(() => new CreditLimiter({ capacity: 0, windowMs: 1, maxInFlight: 1, scheduler })).toThrow(
      RangeError,
    );
    expect(() => new CreditLimiter({ capacity: 1, windowMs: 1, maxInFlight: 0, scheduler })).toThrow(
      RangeError,
    );
    const { limiter } = make();
    await expect(limiter.acquire(101)).rejects.toThrow(/never fit/);
    await expect(limiter.acquire(0)).rejects.toThrow(/never fit/);
  });

  it("an impossible request doesn't block the queue behind it", async () => {
    const { scheduler, limiter } = make();
    const bad = limiter.acquire(1000).catch(() => "rejected");
    const good = limiter.acquire(10).then((release) => (release(), "ok"));
    expect(await scheduler.run(Promise.all([bad, good]))).toEqual(["rejected", "ok"]);
  });

  it("waits for old spends to leave the window", async () => {
    const { scheduler, limiter } = make({ maxInFlight: 100 });
    const at: number[] = [];
    const work = Promise.all(
      [60, 30, 40].map((cost) =>
        limiter.acquire(cost).then((release) => {
          at.push(scheduler.now());
          release();
        }),
      ),
    );
    await scheduler.run(work);
    // 60 + 30 fit at t=0; 40 must wait until the 60 expires at t=1000.
    expect(at).toEqual([0, 0, 1000]);
  });

  it("caps calls in flight and hands slots over in order", async () => {
    const { scheduler, limiter } = make({ maxInFlight: 2 });
    const started: number[] = [];
    const work = Promise.all(
      [0, 1, 2, 3].map(async (i) => {
        const release = await limiter.acquire(1);
        started.push(i);
        await scheduler.sleep(100);
        release();
      }),
    );
    await scheduler.run(work);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(limiter.peakInFlight).toBe(2);
    expect(scheduler.now()).toBe(200);
  });

  it("release is idempotent", async () => {
    const { scheduler, limiter } = make({ maxInFlight: 1 });
    const work = (async () => {
      const r1 = await limiter.acquire(1);
      r1();
      r1();
      const r2 = await limiter.acquire(1);
      const r3 = limiter.acquire(1);
      r2();
      (await r3)();
    })();
    await scheduler.run(work);
    expect(limiter.peakInFlight).toBe(1);
  });

  it("R6.2: pauseFor stops everyone until the server's retry time", async () => {
    const { scheduler, limiter } = make();
    limiter.pauseFor(2500);
    limiter.pauseFor(1000); // a shorter pause never shortens an existing one
    const at = await scheduler.run(limiter.acquire(1).then((r) => (r(), scheduler.now())));
    expect(at).toBe(2500);
    limiter.pauseFor(-5);
    expect(await scheduler.run(limiter.acquire(1).then((r) => (r(), scheduler.now())))).toBe(2500);
  });
});

describe("CreditLimiter properties", () => {
  it("never spends more than the budget in ANY window, never exceeds in-flight, serves FIFO", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            cost: fc.integer({ min: 1, max: 40 }),
            hold: fc.integer({ min: 0, max: 700 }),
            gap: fc.integer({ min: 0, max: 200 }),
          }),
          {
            minLength: 1,
            maxLength: 60,
          },
        ),
        fc.integer({ min: 1, max: 6 }),
        async (calls, maxInFlight) => {
          const scheduler = new VirtualScheduler();
          const limiter = new CreditLimiter({
            capacity: 100,
            windowMs: 1000,
            safety: 1,
            maxInFlight,
            scheduler,
          });
          const spends: { at: number; cost: number }[] = [];
          const order: number[] = [];
          let inFlight = 0;
          let peak = 0;
          const work = (async () => {
            const running: Promise<void>[] = [];
            for (const [i, c] of calls.entries()) {
              await scheduler.sleep(c.gap);
              running.push(
                limiter.acquire(c.cost).then(async (release) => {
                  order.push(i);
                  spends.push({ at: scheduler.now(), cost: c.cost });
                  inFlight += 1;
                  peak = Math.max(peak, inFlight);
                  await scheduler.sleep(c.hold);
                  inFlight -= 1;
                  release();
                }),
              );
            }
            await Promise.all(running);
          })();
          await scheduler.run(work);

          for (const s of spends) {
            const inWindow = spends
              .filter((x) => x.at > s.at - 1000 && x.at <= s.at)
              .reduce((sum, x) => sum + x.cost, 0);
            expect(inWindow).toBeLessThanOrEqual(100);
          }
          expect(peak).toBeLessThanOrEqual(maxInFlight);
          expect(order).toEqual(calls.map((_, i) => i));
        },
      ),
      { numRuns: 150 },
    );
  });
});
