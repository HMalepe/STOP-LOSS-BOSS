/**
 * Structured logging with two layers of secret protection (CLAUDE.md non-negotiable 5):
 * 1. Path redaction: known secret-bearing keys (password, token, cookie, authorization, ...) are masked.
 * 2. Value scrubbing: the actual secret values from the env are masked wherever they appear,
 *    including inside free-text messages, URLs and error stacks, which path redaction can't see.
 */
import pino, { type DestinationStream, type LevelWithSilent, type Logger, type LoggerOptions } from "pino";
import { getEnv, secretValues } from "./env";

export const REDACTED = "[REDACTED]";

const SECRET_KEYS = [
  "password",
  "token",
  "authToken",
  "accessToken",
  "refreshToken",
  "secret",
  "sessionSecret",
  "sessionId",
  "totp",
  "totpCode",
  "recoveryCodes",
  "cookie",
  "authorization",
  "METAAPI_TOKEN",
  "SESSION_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
];

export const REDACT_PATHS: readonly string[] = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
  'headers["auth-token"]',
  'req.headers["auth-token"]',
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
];

/** Shorter values risk masking ordinary words; real secrets here are all long. */
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 8;

export function makeScrubber(secrets: readonly string[]): (value: unknown) => unknown {
  // Longest first, so a secret that contains another is masked whole.
  const needles = [...new Set(secrets)]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  const scrubString = (s: string): string =>
    needles.reduce((acc, needle) => acc.split(needle).join(REDACTED), s);

  const scrub = (value: unknown, depth: number): unknown => {
    if (needles.length === 0) return value;
    if (typeof value === "string") return scrubString(value);
    if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
    if (value instanceof Error) {
      // Keep it an Error (so pino's err serializer still applies) and keep extra fields like `code`,
      // which carry broker retcodes.
      const copy = new Error(scrubString(value.message));
      copy.name = value.name;
      copy.stack = scrubString(value.stack ?? `${value.name}: ${value.message}`);
      for (const [k, v] of Object.entries(value)) {
        Object.defineProperty(copy, k, { value: scrub(v, depth + 1), enumerable: true });
      }
      return copy;
    }
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, depth + 1);
    return out;
  };

  return (value) => scrub(value, 0);
}

export interface CreateLoggerOptions {
  readonly level: LevelWithSilent;
  readonly secrets: readonly string[];
  readonly destination?: DestinationStream;
}

export function createLogger({ level, secrets, destination }: CreateLoggerOptions): Logger {
  const scrub = makeScrubber(secrets);
  const options: LoggerOptions = {
    level,
    base: { service: "order-desk" },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    hooks: {
      logMethod(args, method) {
        const clean = args.map((a) => scrub(a)) as Parameters<typeof method>;
        method.apply(this, clean);
      },
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

let cached: Logger | undefined;

/** The app logger, configured from the validated env. */
export function getLogger(): Logger {
  if (cached === undefined) {
    const env = getEnv();
    cached = createLogger({ level: env.LOG_LEVEL, secrets: secretValues(env) });
  }
  return cached;
}
