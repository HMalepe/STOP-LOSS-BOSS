import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootIo } from "@/server/boot";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fakeIo() {
  const errors: string[] = [];
  const io: BootIo = {
    writeError: (t) => errors.push(t),
    exit: (code) => {
      throw new Exit(code);
    },
  };
  return { io, errors };
}

describe("bootOrExit", () => {
  it("boots on a valid env", async () => {
    vi.stubEnv("TRADING_MODE", "mock");
    vi.stubEnv("SESSION_SECRET", "z".repeat(40));
    vi.stubEnv("LOG_LEVEL", "silent");
    const { bootOrExit } = await import("@/server/boot");
    const { io, errors } = fakeIo();
    expect(() => {
      bootOrExit(io);
    }).not.toThrow();
    expect(errors).toEqual([]);
  });

  it("prints the problems and exits 1 on a bad env, without leaking values", async () => {
    vi.stubEnv("TRADING_MODE", "demo");
    vi.stubEnv("METAAPI_TOKEN", "short-but-secret");
    const { bootOrExit } = await import("@/server/boot");
    const { io, errors } = fakeIo();
    expect(() => {
      bootOrExit(io);
    }).toThrow(new Exit(1));
    expect(errors.join("")).toContain("METAAPI_TOKEN");
    expect(errors.join("")).not.toContain("short-but-secret");
  });
});
