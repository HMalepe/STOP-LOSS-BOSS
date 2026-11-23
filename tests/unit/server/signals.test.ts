import { describe, expect, it, vi } from "vitest";
import { Deferred } from "@/execution/channel";
import { installShutdown, type SignalIo } from "@/server/boot";
import type { ShutdownReport } from "@/server/shutdown";

const clean: ShutdownReport = { abortedAtStart: [], drained: true, interrupted: [], errors: [] };
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function io() {
  const handlers = new Map<string, () => void>();
  const timers: (() => void)[] = [];
  const fake = {
    on: vi.fn((sig: "SIGTERM" | "SIGINT", h: () => void) => handlers.set(sig, h)),
    exit: vi.fn(),
    setTimer: vi.fn((ms: number, fn: () => void) => timers.push(fn) + ms),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies SignalIo;
  return { fake, handlers, timers };
}

describe("SIGTERM / SIGINT", () => {
  it("first signal drains then exits 0; a second signal while draining exits 1 at once", async () => {
    const { fake, handlers } = io();
    const run = new Deferred<ShutdownReport>();
    const shutdown = vi.fn(() => run.promise);
    installShutdown(shutdown, 15_000, fake);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGTERM")?.();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(fake.exit).toHaveBeenCalledWith(1);
    run.resolve(clean);
    await flush();
    expect(fake.exit).toHaveBeenLastCalledWith(0);
  });

  it("a shutdown that didn't drain or hit errors exits 1 and says why", async () => {
    const { fake, handlers } = io();
    installShutdown(() => Promise.resolve({ ...clean, drained: false, interrupted: ["e1"] }), 15_000, fake);
    handlers.get("SIGINT")?.();
    await flush();
    expect(fake.log.warn).toHaveBeenCalled();
    expect(fake.exit).toHaveBeenCalledWith(1);
  });

  it("a shutdown that throws or hangs still exits (backstop timer)", async () => {
    const { fake, handlers, timers } = io();
    installShutdown(() => new Promise<ShutdownReport>(() => undefined), 15_000, fake);
    handlers.get("SIGTERM")?.();
    expect(fake.setTimer).toHaveBeenCalledWith(25_000, expect.any(Function));
    timers[0]?.();
    expect(fake.exit).toHaveBeenCalledWith(1);

    const second = io();
    installShutdown(() => Promise.reject(new Error("boom")), 15_000, second.fake);
    second.handlers.get("SIGTERM")?.();
    await flush();
    expect(second.fake.log.error).toHaveBeenCalled();
    expect(second.fake.exit).toHaveBeenCalledWith(1);
  });
});
