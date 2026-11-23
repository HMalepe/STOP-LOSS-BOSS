/** JSON responses in the 04-API-SPEC shape: success bodies as-is, errors as { error: { code, message, details? } }. */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "TOTP_REQUIRED",
  "REAUTH_REQUIRED",
  "RATE_LIMITED",
  "VALIDATION",
  "FORBIDDEN_ORIGIN",
  "PLAN_INVALID",
  "PLAN_EXPIRED",
  "PLAN_ALREADY_EXECUTED",
  "PRICE_MOVED",
  "PRICE_STALE",
  "TRADING_HALTED",
  "LIVE_NOT_ENABLED",
  "ACCOUNT_MODE_MISMATCH",
  "BROKER_UNAVAILABLE",
  "SHUTTING_DOWN",
  "NOT_FOUND",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  TOTP_REQUIRED: 401,
  REAUTH_REQUIRED: 403,
  RATE_LIMITED: 429,
  VALIDATION: 400,
  FORBIDDEN_ORIGIN: 403,
  PLAN_INVALID: 422,
  PLAN_EXPIRED: 409,
  PLAN_ALREADY_EXECUTED: 409,
  PRICE_MOVED: 409,
  PRICE_STALE: 409,
  TRADING_HALTED: 423,
  LIVE_NOT_ENABLED: 403,
  ACCOUNT_MODE_MISMATCH: 403,
  BROKER_UNAVAILABLE: 503,
  SHUTTING_DOWN: 503,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json" };

export function ok(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(
  code: ErrorCode,
  message: string,
  opts: { details?: unknown; headers?: Record<string, string> } = {},
): Response {
  const error = { code, message, ...(opts.details === undefined ? {} : { details: opts.details }) };
  // A restart takes seconds: tell clients when to come back.
  const retry: Record<string, string> = code === "SHUTTING_DOWN" ? { "Retry-After": "5" } : {};
  return new Response(JSON.stringify({ error }), {
    status: STATUS[code],
    headers: { ...NO_STORE, ...retry, ...opts.headers },
  });
}

export function statusOf(code: ErrorCode): number {
  return STATUS[code];
}
