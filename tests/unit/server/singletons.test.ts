import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getEnv / getLogger", () => {
  it("validates process.env once and caches it", async () => {
    vi.stubEnv("TRADING_MODE", "mock");
    vi.stubEnv("SESSION_SECRET", "z".repeat(40));
    vi.stubEnv("MAX_ORDERS_PER_ACTION", "42");
    const { getEnv } = await import("@/server/env");
    const first = getEnv();
    expect(first.MAX_ORDERS_PER_ACTION).toBe(42);
    vi.stubEnv("MAX_ORDERS_PER_ACTION", "7");
    expect(getEnv()).toBe(first);
  });

  it("fails fast on a bad process.env", async () => {
    vi.stubEnv("TRADING_MODE", "demo");
    const { getEnv, EnvError } = await import("@/server/env");
    expect(() => getEnv()).toThrow(EnvError);
  });

  it("builds one logger from the env", async () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("SESSION_SECRET", "z".repeat(40));
    const { getLogger } = await import("@/server/logger");
    const logger = getLogger();
    expect(logger.level).toBe("warn");
    expect(getLogger()).toBe(logger);
  });
});
