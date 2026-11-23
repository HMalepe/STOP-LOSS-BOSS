/**
 * The API contract (docs/04) as data: response schemas in Zod, plus an OpenAPI 3.1 document built from the SAME request
 * schemas the routes validate with. `pnpm openapi` writes docs/openapi.json; a test fails if it's out of date, and the
 * contract tests parse real responses with these schemas, so docs, validation and behaviour can't drift apart.
 */
import { z } from "zod";
import { closeNowBody } from "@/server/trading/manage";
import { planBody } from "@/server/trading/plans";
import { killBody, liveBody } from "./adminRoutes";
import { codeBody, loginBody } from "./authRoutes";
import { ERROR_CODES, statusOf } from "./respond";

export const errorBody = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

const skipped = z.strictObject({ id: z.string(), reason: z.string() });

export const planSummary = z.strictObject({
  id: z.uuid(),
  action: z.enum(["levels", "closeAt", "close", "breakeven", "lock"]),
  symbol: z.string(),
  expiresAt: z.iso.datetime(),
  quote: z.strictObject({ bid: z.number(), ask: z.number(), time: z.iso.datetime() }).nullable(),
  count: z.number().int().nonnegative(),
  skipped: z.array(skipped),
  breakdown: z.strictObject({
    buys: z.number().int(),
    sells: z.number().int(),
    asSL: z.number().int().optional(),
    asTP: z.number().int().optional(),
    cancels: z.number().int().optional(),
    totalLots: z.number().optional(),
  }),
  warnings: z.array(z.string()),
  mode: z.enum(["mock", "demo", "live"]),
});

export const planViolation = z.strictObject({
  rule: z.string(),
  side: z.enum(["BUY", "SELL"]),
  level: z.enum(["SL", "TP"]).optional(),
  boundary: z.number().optional(),
  count: z.number().int(),
  message: z.string(),
});

export const executeAccepted = z.strictObject({
  executionId: z.uuid(),
  count: z.number().int().nonnegative(),
  skipped: z.array(skipped),
});

export const closeNowAccepted = z.strictObject({ executionId: z.uuid(), plan: planSummary });

export const progress = z.strictObject({
  total: z.number().int(),
  done: z.number().int(),
  ok: z.number().int(),
  failed: z.number().int(),
  unknown: z.number().int(),
  skipped: z.number().int(),
});

export const executionStatus = z.object({
  executionId: z.uuid(),
  planId: z.string(),
  state: z.enum(["running", "complete", "interrupted"]),
  progress: progress.optional(),
  summary: z.unknown().optional(),
});

export const sseItem = z.strictObject({
  index: z.number().int(),
  op: z.enum(["modify", "close", "cancel", "market", "pending"]),
  targetId: z.string(),
  ok: z.boolean(),
  outcome: z.enum(["done", "failed", "unknown", "skipped"]),
  code: z.number().int().nullable(),
  message: z.string(),
  attempts: z.number().int(),
  latencyMs: z.number().int(),
});

export const historyPage = z.strictObject({
  items: z.array(
    z.strictObject({
      executionId: z.uuid(),
      planId: z.string(),
      action: z.string(),
      symbol: z.string(),
      status: z.string(),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime().nullable(),
      summary: z.unknown(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const position = z.object({
  id: z.string(),
  symbol: z.string(),
  side: z.enum(["BUY", "SELL"]),
  volume: z.number(),
  openPrice: z.number(),
  sl: z.number().nullable(),
  tp: z.number().nullable(),
  profit: z.number(),
  magic: z.number().int(),
});

export const positionsPage = z.strictObject({
  items: z.array(position),
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

const sideSummary = z.strictObject({ count: z.number().int(), lots: z.number(), profit: z.number() });
export const stateView = z.object({
  mode: z.enum(["mock", "demo", "live"]),
  killSwitch: z.strictObject({ halted: z.boolean(), byEnv: z.boolean(), byDb: z.boolean() }),
  account: z.object({ currency: z.string(), balance: z.number(), equity: z.number(), tradeMode: z.string() }),
  symbols: z.array(
    z.strictObject({ symbol: z.string(), buy: sideSummary, sell: sideSummary, orders: z.number().int() }),
  ),
  positions: z.number().int(),
  orders: z.number().int(),
  focus: z
    .object({
      symbol: z.string(),
      quote: z.object({ bid: z.number(), ask: z.number(), time: z.number() }),
      spec: z.object({ digits: z.number().int(), point: z.number() }),
    })
    .optional(),
});

type Schema = z.ZodType;
const json = (s: Schema, io: "input" | "output") => z.toJSONSchema(s, { io, unrepresentable: "any" });

interface Op {
  readonly method: "get" | "post";
  readonly path: string;
  readonly summary: string;
  readonly body?: Schema;
  readonly ok: { readonly status: number; readonly schema?: Schema; readonly sse?: true };
  readonly errors: readonly (typeof ERROR_CODES)[number][];
  readonly query?: Readonly<Record<string, string>>;
  readonly public?: true;
}

const AUTHED = ["UNAUTHENTICATED", "TOTP_REQUIRED", "FORBIDDEN_ORIGIN", "INTERNAL"] as const;

export const OPERATIONS: readonly Op[] = [
  {
    method: "post",
    path: "/api/auth/login",
    summary: "Password step",
    body: loginBody,
    ok: { status: 200 },
    errors: ["VALIDATION", "UNAUTHENTICATED", "RATE_LIMITED", "FORBIDDEN_ORIGIN"],
    public: true,
  },
  {
    method: "post",
    path: "/api/auth/totp",
    summary: "Code step → session cookie",
    body: codeBody,
    ok: { status: 200 },
    errors: ["VALIDATION", "UNAUTHENTICATED", "RATE_LIMITED", "FORBIDDEN_ORIGIN"],
    public: true,
  },
  {
    method: "post",
    path: "/api/auth/logout",
    summary: "End the session",
    ok: { status: 204 },
    errors: ["FORBIDDEN_ORIGIN"],
    public: true,
  },
  {
    method: "post",
    path: "/api/auth/reauth",
    summary: "Fresh code for sensitive changes",
    body: codeBody,
    ok: { status: 200 },
    errors: ["VALIDATION", "UNAUTHENTICATED", "RATE_LIMITED", "FORBIDDEN_ORIGIN"],
    public: true,
  },
  {
    method: "post",
    path: "/api/auth/sessions/revoke-all",
    summary: "Sign out everywhere (re-auth)",
    ok: { status: 200 },
    errors: [...AUTHED, "REAUTH_REQUIRED"],
  },
  {
    method: "get",
    path: "/api/state",
    summary: "Account, mode, kill switch, per-symbol summary; quote + spec for ?symbol",
    query: { symbol: "Symbol to focus on" },
    ok: { status: 200, schema: stateView },
    errors: [...AUTHED, "VALIDATION", "BROKER_UNAVAILABLE", "ACCOUNT_MODE_MISMATCH"],
  },
  {
    method: "get",
    path: "/api/positions",
    summary: "Open positions, paged at 500",
    query: { symbol: "Filter", side: "ALL | BUY | SELL", cursor: "nextCursor from the previous page" },
    ok: { status: 200, schema: positionsPage },
    errors: [...AUTHED, "VALIDATION", "BROKER_UNAVAILABLE"],
  },
  {
    method: "post",
    path: "/api/plans",
    summary: "Dry run: build and store a plan for 30 s",
    body: planBody,
    ok: { status: 201, schema: planSummary },
    errors: [...AUTHED, "VALIDATION", "PLAN_INVALID", "PRICE_STALE", "BROKER_UNAVAILABLE"],
  },
  {
    method: "get",
    path: "/api/plans/{id}",
    summary: "Stored plan summary and its exact items",
    ok: { status: 200 },
    errors: [...AUTHED, "NOT_FOUND"],
  },
  {
    method: "post",
    path: "/api/plans/{id}/execute",
    summary: "Execute the stored plan (body ignored)",
    ok: { status: 202, schema: executeAccepted },
    errors: [
      ...AUTHED,
      "NOT_FOUND",
      "PLAN_EXPIRED",
      "PLAN_ALREADY_EXECUTED",
      "TRADING_HALTED",
      "LIVE_NOT_ENABLED",
      "ACCOUNT_MODE_MISMATCH",
      "PRICE_MOVED",
      "PRICE_STALE",
      "BROKER_UNAVAILABLE",
    ],
  },
  {
    method: "get",
    path: "/api/executions/{id}",
    summary: "Status, progress, counts",
    ok: { status: 200, schema: executionStatus },
    errors: [...AUTHED, "NOT_FOUND"],
  },
  {
    method: "get",
    path: "/api/executions/{id}/stream",
    summary: "SSE: item, progress, complete, error. Resume with Last-Event-ID",
    ok: { status: 200, sse: true },
    errors: [...AUTHED, "NOT_FOUND"],
  },
  {
    method: "post",
    path: "/api/executions/{id}/retry-failed",
    summary: "New plan of the failed items (never unknown ones)",
    ok: { status: 201, schema: planSummary },
    errors: [...AUTHED, "NOT_FOUND", "VALIDATION", "PLAN_INVALID", "BROKER_UNAVAILABLE"],
  },
  {
    method: "post",
    path: "/api/close-now",
    summary: "Close everything matching, now (urgent lane)",
    body: closeNowBody,
    ok: { status: 202, schema: closeNowAccepted },
    errors: [...AUTHED, "VALIDATION", "PLAN_INVALID", "ACCOUNT_MODE_MISMATCH", "BROKER_UNAVAILABLE"],
  },
  {
    method: "get",
    path: "/api/history",
    summary: "Past executions, newest first",
    query: { cursor: "nextCursor from the previous page" },
    ok: { status: 200, schema: historyPage },
    errors: [...AUTHED, "VALIDATION"],
  },
  {
    method: "get",
    path: "/api/admin/kill-switch",
    summary: "Kill switch state",
    ok: { status: 200 },
    errors: [...AUTHED],
  },
  {
    method: "post",
    path: "/api/admin/kill-switch",
    summary: "Kill switch on (instant) / off (re-auth)",
    body: killBody,
    ok: { status: 200 },
    errors: [...AUTHED, "VALIDATION", "REAUTH_REQUIRED"],
  },
  {
    method: "post",
    path: "/api/admin/live",
    summary: "Live opt-in for an account (on needs re-auth)",
    body: liveBody,
    ok: { status: 200 },
    errors: [...AUTHED, "VALIDATION", "REAUTH_REQUIRED", "NOT_FOUND"],
  },
];

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const params = [
      ...[...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
        name: m[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      ...Object.entries(op.query ?? {}).map(([name, description]) => ({
        name,
        in: "query",
        required: false,
        description,
        schema: { type: "string" },
      })),
    ];
    const byStatus = new Map<number, string[]>();
    for (const code of op.errors) {
      byStatus.set(statusOf(code), [...(byStatus.get(statusOf(code)) ?? []), code]);
    }
    const responses: Record<string, unknown> = {
      [String(op.ok.status)]: {
        description: op.ok.sse === true ? "text/event-stream" : "OK",
        ...(op.ok.schema === undefined
          ? {}
          : { content: { "application/json": { schema: json(op.ok.schema, "output") } } }),
      },
    };
    for (const [status, codes] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
      responses[String(status)] = {
        description: codes.join(" | "),
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }
    (paths[op.path] ??= {})[op.method] = {
      summary: op.summary,
      ...(op.public === true ? { security: [] } : {}),
      ...(params.length === 0 ? {} : { parameters: params }),
      ...(op.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { "application/json": { schema: json(op.body, "input") } },
            },
          }),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Order Desk API",
      version: "0.6.0",
      description:
        "Generated from the Zod schemas the routes validate with (src/server/http/contract.ts). Do not edit by hand: run `pnpm openapi`.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: { session: { type: "apiKey", in: "cookie", name: "__Host-od_session" } },
      schemas: {
        Error: json(errorBody, "output"),
        PlanViolation: json(planViolation, "output"),
        SseItem: json(sseItem, "output"),
        Progress: json(progress, "output"),
      },
    },
    security: [{ session: [] }],
    paths,
  };
}
