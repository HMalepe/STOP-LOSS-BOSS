import { describe, expect, it } from "vitest";
import { EnvError, loadEnv, MOCK_DATABASE_URL, secretValues } from "@/server/env";

const TOKEN = "mtapi-token-0123456789abcdefghijklmnop";
const SECRET = "s".repeat(24) + "-session-secret-xyz";
const DB = "postgres://app:p%40ss-w0rd-long@db.example.com:5432/app";

/** The minimum for mock mode: a stable session secret (it encrypts the TOTP secret). */
const MOCK = { SESSION_SECRET: SECRET };

const demoBase = {
  TRADING_MODE: "demo",
  METAAPI_TOKEN: TOKEN,
  METAAPI_ACCOUNT_ID: "acc-123",
  METAAPI_REGION: "new-york",
  SESSION_SECRET: SECRET,
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: DB,
  TRUSTED_IP_HEADER: "x-forwarded-for",
  NEXT_MANUAL_SIG_HANDLE: "true",
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
  it("mock needs only a session secret; safe defaults; embedded database", () => {
    const env = loadEnv(MOCK);
    expect(env.TRADING_MODE).toBe("mock");
    expect(env.TRADING_HALTED).toBe(false);
    expect(env.DATABASE_URL).toBe(MOCK_DATABASE_URL);
    expect(env.MAX_ORDERS_PER_ACTION).toBe(100);
    expect(env.MAX_TOTAL_LOTS).toBe(5);
    expect(env.MAX_RISK_PCT_PER_ACTION).toBe(2);
    expect(env.SPREAD_GUARD_K).toBe(3);
    expect(env.SPREAD_WINDOW_SEC).toBe(300);
    expect(env.APP_MAGIC_PREFIX).toBe(7731);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("the session secret is required in every mode (Phase 05)", () => {
    expect(problemsOf({})[0]).toMatch(/^SESSION_SECRET:/);
    expect(problemsOf({ SESSION_SECRET: "too short" })).toEqual([
      "SESSION_SECRET: must be at least 32 characters",
    ]);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadEnv(MOCK))).toBe(true);
  });

  it("treats blank and whitespace values as unset (common .env gotcha)", () => {
    const env = loadEnv({ ...MOCK, TRADING_MODE: "  ", MAX_ORDERS_PER_ACTION: "", METAAPI_TOKEN: "   " });
    expect(env.TRADING_MODE).toBe("mock");
    expect(env.MAX_ORDERS_PER_ACTION).toBe(100);
    expect(env.METAAPI_TOKEN).toBeUndefined();
  });

  it("parses the kill switch", () => {
    expect(loadEnv({ ...MOCK, TRADING_HALTED: "1" }).TRADING_HALTED).toBe(true);
    expect(problemsOf({ ...MOCK, TRADING_HALTED: "yes" })[0]).toMatch(/^TRADING_HALTED:/);
  });
});

describe("loadEnv per mode", () => {
  it("demo requires broker credentials, origin and a real database, and lists them all at once", () => {
    const problems = problemsOf({ TRADING_MODE: "demo", SESSION_SECRET: SECRET });
    for (const key of [
      "METAAPI_TOKEN",
      "METAAPI_ACCOUNT_ID",
      "METAAPI_REGION",
      "APP_ORIGIN",
      "DATABASE_URL",
      "TRUSTED_IP_HEADER",
      "NEXT_MANUAL_SIG_HANDLE",
    ]) {
      expect(problems).toContain(`${key}: required when TRADING_MODE=demo`);
    }
  });

  it("R9.4a SPREAD_MAX_POINTS: off by default, parsed per symbol, nonsense refused", () => {
    expect(loadEnv(demoBase).SPREAD_MAX_POINTS).toEqual({});
    expect(loadEnv({ ...demoBase, SPREAD_MAX_POINTS: "EURUSD:30,XAUUSD:80" }).SPREAD_MAX_POINTS).toEqual({
      EURUSD: 30,
      XAUUSD: 80,
    });
    expect(problemsOf({ ...demoBase, SPREAD_MAX_POINTS: "EURUSD=30" })[0]).toMatch(/^SPREAD_MAX_POINTS:/);
  });

  it("graceful shutdown: signal handling must be ours outside mock; drain window is bounded", () => {
    expect(problemsOf({ ...demoBase, NEXT_MANUAL_SIG_HANDLE: "1" })[0]).toMatch(/^NEXT_MANUAL_SIG_HANDLE:/);
    expect(loadEnv(demoBase).SHUTDOWN_DRAIN_MS).toBe(15_000);
    expect(problemsOf({ ...demoBase, SHUTDOWN_DRAIN_MS: "500" })[0]).toMatch(/^SHUTDOWN_DRAIN_MS:/);
    expect(loadEnv({ SESSION_SECRET: SECRET }).NEXT_MANUAL_SIG_HANDLE).toBeUndefined();
  });

  it("APP_ORIGIN is normalised to a bare origin (a trailing slash or path can't break the CSRF check)", () => {
    expect(loadEnv({ ...demoBase, APP_ORIGIN: "https://desk.example.com/" }).APP_ORIGIN).toBe(
      "https://desk.example.com",
    );
    expect(loadEnv({ ...demoBase, APP_ORIGIN: "https://Desk.Example.com:8443/app?x=1" }).APP_ORIGIN).toBe(
      "https://desk.example.com:8443",
    );
  });

  it("TRUSTED_IP_HEADER: only known proxy headers; mock defaults to X-Forwarded-For", () => {
    expect(loadEnv(MOCK).TRUSTED_IP_HEADER).toBe("x-forwarded-for");
    expect(loadEnv({ ...demoBase, TRUSTED_IP_HEADER: "cf-connecting-ip" }).TRUSTED_IP_HEADER).toBe(
      "cf-connecting-ip",
    );
    expect(problemsOf({ ...demoBase, TRUSTED_IP_HEADER: "x-my-ip" })[0]).toMatch(/^TRUSTED_IP_HEADER:/);
  });

  it("accepts a complete demo env", () => {
    expect(loadEnv(demoBase).TRADING_MODE).toBe("demo");
  });

  it("embedded pglite is refused outside mock mode", () => {
    expect(problemsOf({ ...demoBase, DATABASE_URL: "pglite://.data/x" })).toEqual([
      "DATABASE_URL: embedded pglite is for mock mode only, not demo",
    ]);
    expect(loadEnv({ ...MOCK, DATABASE_URL: "pglite://memory" }).DATABASE_URL).toBe("pglite://memory");
  });

  it("rejects a database URL that isn't postgres", () => {
    expect(problemsOf({ ...MOCK, DATABASE_URL: "mysql://x" })[0]).toMatch(/^DATABASE_URL:/);
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
    expect(problemsOf({ ...MOCK, TRADING_MODE: "real" })[0]).toMatch(/^TRADING_MODE:/);
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
    expect(problemsOf({ ...MOCK, [key]: value })[0]).toMatch(new RegExp(`^${key}:`));
  });

  it("keeps the magic range below 2^53 at the max prefix (R9.1)", () => {
    const env = loadEnv({ ...MOCK, APP_MAGIC_PREFIX: "9007198" });
    expect(Number.isSafeInteger(env.APP_MAGIC_PREFIX * 1e9 + (1e9 - 1))).toBe(true);
  });

  it("never echoes a secret value in the error", () => {
    try {
      loadEnv({ ...demoBase, SESSION_SECRET: "tooShortButSecret", METAAPI_TOKEN: "leaky-token" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const text = (e as EnvError).message;
      expect(text).not.toContain("tooShortButSecret");
      expect(text).not.toContain("leaky-token");
      expect(text).toContain("SESSION_SECRET");
    }
  });
});

describe("secretValues", () => {
  it("a mock env's only secret is the session secret (the pglite path isn't one)", () => {
    expect(secretValues(loadEnv(MOCK))).toEqual([SECRET]);
  });

  it("collects tokens, secrets and the database password", () => {
    const env = loadEnv({ ...demoBase, SUPABASE_SERVICE_ROLE_KEY: "service-role-key-abcdefghijkl" });
    expect(secretValues(env)).toEqual(
      expect.arrayContaining([TOKEN, SECRET, "service-role-key-abcdefghijkl", DB, "p@ss-w0rd-long"]),
    );
  });

  it("skips a database URL with no password", () => {
    const env = loadEnv({ ...demoBase, DATABASE_URL: "postgres://db.example.com/app" });
    expect(secretValues(env)).toEqual(expect.arrayContaining(["postgres://db.example.com/app"]));
    expect(secretValues(env)).toHaveLength(3);
  });
});
