/**
 * Environment config, validated once at boot. The app refuses to start on bad config (docs/05-SECURITY.md).
 *
 * Rules:
 * - Default mode is `mock`: no broker, no secrets needed.
 * - `demo` and `live` need the MetaApi credentials, a session secret and the app origin.
 * - `live` needs an https origin. (Live also needs `accounts.live_enabled` in the DB: that check lives in src/server, Phase 05.)
 * - Error messages name the variable and the problem, never the value: a typo'd token must not end up in a crash log.
 */
import { z } from "zod";
import { TRUSTED_IP_HEADERS } from "./http/request";

const TRADING_MODES = ["mock", "demo", "live"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z
  .object({
    TRADING_MODE: z.enum(TRADING_MODES).default("mock"),
    TRADING_HALTED: z
      .enum(["0", "1"])
      .default("0")
      .transform((v) => v === "1"),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

    METAAPI_TOKEN: z.string().min(20).optional(),
    METAAPI_ACCOUNT_ID: z.string().min(1).optional(),
    METAAPI_REGION: z
      .string()
      .regex(/^[a-z0-9-]+$/, "must be a MetaApi region slug like new-york")
      .optional(),

    // Always required: it encrypts the TOTP secret and so must be stable across restarts (Phase 05).
    SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
    // Normalised to a bare origin (scheme://host[:port]) so a trailing slash or path can't break the CSRF check.
    APP_ORIGIN: z
      .url()
      .transform((u) => new URL(u).origin)
      .optional(),
    // The one header our host's proxy sets with the client IP (rate limiting keys on it). Required outside mock: a wrong
    // guess either lets clients forge their IP or puts everyone in one bucket, so it must be a deliberate choice.
    TRUSTED_IP_HEADER: z.enum(TRUSTED_IP_HEADERS).optional(),

    // postgres(ql)://… for demo/live (Supabase); mock may use embedded Postgres: pglite://<dir> or pglite://memory.
    DATABASE_URL: z
      .string()
      .regex(/^(postgres(ql)?:\/\/|pglite:)/, "must be a postgres:// URL (or pglite: in mock mode)")
      .optional(),
    SUPABASE_URL: z.url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),

    // Caps (R5.2, OD7). Upper bounds are sanity limits, not recommendations.
    MAX_ORDERS_PER_ACTION: int(1, 500, 100),
    MAX_TOTAL_LOTS: z.coerce.number().positive().max(100).default(5),
    MAX_RISK_PCT_PER_ACTION: z.coerce.number().positive().max(10).default(2),

    // Adaptive spread guard (R9.4b).
    SPREAD_GUARD_K: z.coerce.number().min(1.5).max(20).default(3),
    SPREAD_WINDOW_SEC: int(30, 3600, 300),

    // Batch identity (R9.1): prefix × 10^9 + batchSeq must stay below 2^53.
    APP_MAGIC_PREFIX: int(1, 9_007_198, 7731),
  })
  .superRefine((env, ctx) => {
    if (env.TRADING_MODE === "mock") return;

    const required = [
      "METAAPI_TOKEN",
      "METAAPI_ACCOUNT_ID",
      "METAAPI_REGION",
      "APP_ORIGIN",
      "DATABASE_URL",
      "TRUSTED_IP_HEADER",
    ] as const;
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `required when TRADING_MODE=${env.TRADING_MODE}`,
        });
      }
    }

    if (
      env.TRADING_MODE === "live" &&
      env.APP_ORIGIN !== undefined &&
      !env.APP_ORIGIN.startsWith("https://")
    ) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "must be https:// in live mode" });
    }
    if (env.DATABASE_URL?.startsWith("pglite:") === true) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: `embedded pglite is for mock mode only, not ${env.TRADING_MODE}`,
      });
    }
  })
  .transform((env) => ({
    ...env,
    DATABASE_URL: env.DATABASE_URL ?? MOCK_DATABASE_URL,
    TRUSTED_IP_HEADER: env.TRUSTED_IP_HEADER ?? "x-forwarded-for",
  }));

/** Mock mode's default: embedded Postgres persisted to ./.data, so `pnpm dev` needs no database server. */
export const MOCK_DATABASE_URL = "pglite://.data/order-desk";

export type Env = Readonly<z.output<typeof schema>>;

export class EnvError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment, refusing to start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvError";
    this.problems = problems;
  }
}

/** Blank values in .env files mean "not set", not "empty string". */
function normalise(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed !== "") out[key] = trimmed;
  }
  return out;
}

/** Pure: parse any env-like record. Throws EnvError listing every problem at once. */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = schema.safeParse(normalise(source));
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join(".") || "(root)";
      return `${key}: ${issue.message}`;
    });
    throw new EnvError(problems);
  }
  return Object.freeze(result.data);
}

/** Every secret value present in this env, for value-based log scrubbing. */
export function secretValues(env: Env): string[] {
  const values: string[] = [];
  for (const v of [env.METAAPI_TOKEN, env.SESSION_SECRET, env.SUPABASE_SERVICE_ROLE_KEY, env.DATABASE_URL]) {
    if (v !== undefined && !v.startsWith("pglite:")) values.push(v);
  }
  if (!env.DATABASE_URL.startsWith("pglite:")) {
    const password = decodeURIComponent(new URL(env.DATABASE_URL).password);
    if (password !== "") values.push(password);
  }
  return values;
}

let cached: Env | undefined;

/** The process env, validated once and cached. Server code calls this; tests call loadEnv. */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}
