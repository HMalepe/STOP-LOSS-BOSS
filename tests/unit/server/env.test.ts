import { describe, expect, it } from "vitest";
import { EnvError, loadEnv, secretValues } from "@/server/env";

const TOKEN = "mtapi-token-0123456789abcdefghijklmnop";
const SECRET = "s".repeat(24) + "-session-secret-xyz";

const demoBase = {
  TRADING_MODE: "demo",
  METAAPI_TOKEN: TOKEN,
  METAAPI_ACCOUNT_ID: "acc-123",
  METAAPI_REGION: "new-york",
  SESSION_SECRET: SECRET,
  APP_ORIGIN: "http://localhost:3000",
};

function problemsOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    loadEnv(source);
  } catch (e) {
    if (e instanceof EnvError) return e.problems;
    throw e;
  }
  throw new Error("expected EnvError");
}

describe("loadEnv defaults", () => {
  it("an empty env is a valid mock env with safe defaults", () => {
    const env = loadEnv({});
    expect(env.TRADING_MODE).toBe("mock");
    expect(env.TRADING_HALTED).toBe(false);
    expect(env.MAX_ORDERS_PER_ACTION).toBe(100);
    expect(env.MAX_TOTAL_LOTS).toBe(5);
    expect(env.MAX_RISK_PCT_PER_ACTION).toBe(2);
    expect(env.SPREAD_GUARD_K).toBe(3);
    expect(env.SPREAD_WINDOW_SEC).toBe(300);
    expect(env.APP_MAGIC_PREFIX).toBe(7731);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadEnv({}))).toBe(true);
  });

  it("treats blank and whitespace values as unset (common .env gotcha)", () => {
    const env = loadEnv({ TRADING_MODE: "  ", MAX_ORDERS_PER_ACTION: "", METAAPI_TOKEN: "   " });
    expect(env.TRADING_MODE).toBe("mock");
    expect(env.MAX_ORDERS_PER_ACTION).toBe(100);
    expect(env.METAAPI_TOKEN).toBeUndefined();
  });

  it("parses the kill switch", () => {
    expect(loadEnv({ TRADING_HALTED: "1" }).TRADING_HALTED).toBe(true);
    expect(problemsOf({ TRADING_HALTED: "yes" })[0]).toMatch(/^TRADING_HALTED:/);
  });
});

describe("loadEnv per mode", () => {
  it("demo requires broker credentials, session secret and origin, and lists them all at once", () => {
    const problems = problemsOf({ TRADING_MODE: "demo" });
    for (const key of [
      "METAAPI_TOKEN",
      "METAAPI_ACCOUNT_ID",
      "METAAPI_REGION",
      "SESSION_SECRET",
      "APP_ORIGIN",
    ]) {
      expect(problems).toContain(`${key}: required when TRADING_MODE=demo`);
    }
  });

  it("accepts a complete demo env", () => {
    expect(loadEnv(demoBase).TRADING_MODE).toBe("demo");
  });

  it("live refuses a plain-http origin", () => {
    expect(problemsOf({ ...demoBase, TRADING_MODE: "live" })).toEqual([
      "APP_ORIGIN: must be https:// in live mode",
    ]);
  });

  it("accepts live with https", () => {
    expect(
      loadEnv({ ...demoBase, TRADING_MODE: "live", APP_ORIGIN: "https://desk.example.com" }).TRADING_MODE,
    ).toBe("live");
  });

  it("rejects an unknown mode", () => {
    expect(problemsOf({ TRADING_MODE: "real" })[0]).toMatch(/^TRADING_MODE:/);
  });
});

describe("loadEnv value checks", () => {
  it.each([
    ["MAX_ORDERS_PER_ACTION", "0"],
    ["MAX_ORDERS_PER_ACTION", "501"],
    ["MAX_ORDERS_PER_ACTION", "2.5"],
    ["MAX_TOTAL_LOTS", "-1"],
    ["MAX_RISK_PCT_PER_ACTION", "11"],
    ["SPREAD_GUARD_K", "1"],
    ["SPREAD_WINDOW_SEC", "10"],
    ["APP_MAGIC_PREFIX", "9007199"],
    ["METAAPI_REGION", "New York"],
    ["LOG_LEVEL", "loud"],
  ])("rejects %s=%s", (key, value) => {
    expect(problemsOf({ [key]: value })[0]).toMatch(new RegExp(`^${key}:`));
  });

  it("keeps the magic range below 2^53 at the max prefix (R9.1)", () => {
    const env = loadEnv({ APP_MAGIC_PREFIX: "9007198" });
    expect(Number.isSafeInteger(env.APP_MAGIC_PREFIX * 1e9 + (1e9 - 1))).toBe(true);
  });

  it("never echoes a secret value in the error", () => {
    const shortSecret = "tooShortButSecret";
    try {
      loadEnv({ ...demoBase, SESSION_SECRET: shortSecret, METAAPI_TOKEN: "leaky-token" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const text = (e as EnvError).message;
      expect(text).not.toContain(shortSecret);
      expect(text).not.toContain("leaky-token");
      expect(text).toContain("SESSION_SECRET");
    }
  });
});

describe("secretValues", () => {
  it("is empty for a mock env", () => {
    expect(secretValues(loadEnv({}))).toEqual([]);
  });

  it("collects tokens, secrets and the database password", () => {
    const env = loadEnv({
      ...demoBase,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-abcdefghijkl",
      DATABASE_URL: "postgres://app:p%40ss-w0rd-long@db.example.com:5432/app",
    });
    const values = secretValues(env);
    expect(values).toEqual(
      expect.arrayContaining([
        TOKEN,
        SECRET,
        "service-role-key-abcdefghijkl",
        "postgres://app:p%40ss-w0rd-long@db.example.com:5432/app",
        "p@ss-w0rd-long",
      ]),
    );
  });

  it("skips a database URL with no password", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://db.example.com/app" });
    expect(secretValues(env)).toEqual(["postgres://db.example.com/app"]);
  });
});
