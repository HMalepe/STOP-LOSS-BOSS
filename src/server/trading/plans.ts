/**
 * Plans (docs/04, non-negotiable 1: preview before execute).
 * A plan is built from a FRESH snapshot by the pure domain builder, then stored with its exact items, a hash of them,
 * and a 30 s expiry. Execute (M3) runs the stored items, never anything from a request, and refuses if the hash no
 * longer matches what was stored.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EntryItem } from "@/domain/entries";
import type { LadderItem } from "@/domain/ladder";
import { buildPlan, type PlanDraft, type PlanError, type PlanRequest } from "@/domain/plan";
import type { PlanItem, Position, Skipped } from "@/domain/types";
import { canonical } from "../audit/audit";
import { sha256 } from "../auth/crypto";
import type { Db } from "../db/sql";
import type { TradingMode } from "../env";
import type { TradingServices } from "./services";

export const PLAN_TTL_MS = 30_000;
/** R7.2 */
export const MAX_QUOTE_AGE_MS = 3_000;

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");
const PRICE = z.number().positive();
const POINTS = z.number().int().nonnegative().max(1_000_000);

const filter = z.strictObject({
  symbol: SYMBOL,
  side: z.enum(["ALL", "BUY", "SELL"]),
  magic: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  inProfitOnly: z.boolean().optional(),
});

/** The actions the preview supports today. Entries (market, ladder) and cancel arrive with the Order Desk (Phase 08). */
export const planBody = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("levels"),
    filter,
    stopLoss: PRICE.optional(),
    takeProfit: PRICE.optional(),
  }),
  z.strictObject({ action: z.literal("closeAt"), filter, price: PRICE }),
  z.strictObject({ action: z.literal("breakeven"), filter, offsetPoints: POINTS }),
  z.strictObject({ action: z.literal("lock"), filter, distancePoints: POINTS.min(1) }),
]);
export type PlanBody = z.infer<typeof planBody>;
export const LATER_ACTIONS = new Set(["cancel"]);

/** What an entry plan adds to its summary (risk, margin, spread, expiry, batch number). */
export interface EntrySummary {
  readonly kind: "market" | "ladder";
  readonly side: "BUY" | "SELL";
  readonly totalLots: number;
  readonly risk: {
    readonly total: number | null;
    readonly unlimited: boolean;
    readonly pctOfEquity: number | null;
  };
  readonly margin: { readonly required: number; readonly freeMargin: number };
  readonly spread: { readonly nowPoints: number; readonly normalPoints: number | null };
  readonly expiry?: { readonly type: "DAY" | "GTC" | "SPECIFIED"; readonly time?: string };
  readonly requestedLevels?: number;
  readonly duplicatesRemoved?: number;
  /** R9.1: set when the plan is stored. */
  readonly batchSeq?: number;
}

export interface PlanSummary {
  readonly id: string;
  readonly action: PlanDraft["action"] | "market" | "ladder";
  readonly symbol: string;
  readonly expiresAt: string;
  readonly quote: { readonly bid: number; readonly ask: number; readonly time: string } | null;
  readonly count: number;
  readonly skipped: readonly Skipped[];
  readonly breakdown: PlanDraft["breakdown"] & {
    readonly totalLots?: number;
    readonly prices?: readonly number[];
  };
  readonly warnings: readonly string[];
  readonly mode: TradingMode;
  readonly entry?: EntrySummary;
}

export type CreatePlanResult =
  | { readonly ok: true; readonly summary: PlanSummary }
  | {
      readonly ok: false;
      readonly error: PlanError | { readonly code: "PRICE_STALE"; readonly message: string };
    };

/** Strip `undefined` optionals so the domain type (exactOptionalPropertyTypes) is met exactly. */
function toRequest(body: PlanBody): PlanRequest {
  const f = {
    symbol: body.filter.symbol,
    side: body.filter.side,
    ...(body.filter.magic === undefined ? {} : { magic: body.filter.magic }),
    ...(body.filter.inProfitOnly === undefined ? {} : { inProfitOnly: body.filter.inProfitOnly }),
  };
  switch (body.action) {
    case "levels":
      return {
        action: "levels",
        filter: f,
        ...(body.stopLoss === undefined ? {} : { stopLoss: body.stopLoss }),
        ...(body.takeProfit === undefined ? {} : { takeProfit: body.takeProfit }),
      };
    case "closeAt":
      return { action: "closeAt", filter: f, price: body.price };
    case "breakeven":
      return { action: "breakeven", filter: f, offsetPoints: body.offsetPoints };
    case "lock":
      return { action: "lock", filter: f, distancePoints: body.distancePoints };
  }
}

/** What execute checks against: the exact broker calls, in order. */
export function itemsHash(items: readonly unknown[]): string {
  return sha256(canonical(items));
}

const cents = (n: number) => Math.round(n * 1e6) / 1e6;

export async function createPlan(
  svc: TradingServices,
  db: Db,
  userId: string,
  body: PlanBody,
  /** Writes the audit row in the same transaction as the plan. */
  record: (tx: Db, summary: PlanSummary) => Promise<unknown>,
): Promise<CreatePlanResult> {
  const req = toRequest(body);
  const symbol = req.filter.symbol;
  const [positions, orders, quote, spec] = await Promise.all([
    svc.broker.getPositions(),
    svc.broker.getOrders(),
    svc.broker.getQuote(symbol),
    svc.specs.get(symbol),
  ]);
  const now = svc.clock.now();
  if (now - quote.time > MAX_QUOTE_AGE_MS) {
    return {
      ok: false,
      error: {
        code: "PRICE_STALE",
        message: "The last price is too old to check against (market closed or feed lagging). Try again.",
      },
    };
  }
  const built = buildPlan(req, { positions, orders, quote, spec });
  if (!built.ok) return built;
  if (built.plan.items.length > svc.maxPerBatch) {
    return {
      ok: false,
      error: {
        code: "PLAN_INVALID",
        message: `That's ${String(built.plan.items.length)} positions; one action may change at most ${String(svc.maxPerBatch)}. Narrow the filter (side, magic) or raise MAX_POSITIONS_PER_BATCH.`,
        details: [],
      },
    };
  }
  const summary = await storePlan(svc, db, userId, built.plan, req, positions, record);
  return { ok: true, summary };
}

/**
 * Store a built plan: summary + exact items + their hash, 30 s expiry, in one transaction with its audit row.
 * Shared by preview, close-now and retry-failed, so every path that executes goes through the same record.
 */
export async function storePlan(
  svc: Pick<TradingServices, "clock" | "mode">,
  db: Db,
  userId: string,
  plan: PlanDraft,
  params: unknown,
  positions: readonly Position[],
  record: (tx: Db, summary: PlanSummary) => Promise<unknown>,
): Promise<PlanSummary> {
  const now = svc.clock.now();
  const byId = new Map(positions.map((p) => [p.id, p.volume]));
  const lots = plan.items.reduce((a, i) => (i.op === "close" ? a + (byId.get(i.positionId) ?? 0) : a), 0);
  const id = randomUUID();
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();
  const summary: PlanSummary = {
    id,
    action: plan.action,
    symbol: plan.symbol,
    expiresAt,
    quote:
      plan.quote === null
        ? null
        : { bid: plan.quote.bid, ask: plan.quote.ask, time: new Date(plan.quote.time).toISOString() },
    count: plan.items.length,
    skipped: plan.skipped,
    breakdown: { ...plan.breakdown, ...(lots > 0 ? { totalLots: cents(lots) } : {}) },
    warnings: plan.warnings,
    mode: svc.mode,
  };
  await db.tx(async (t) => {
    // Housekeeping (security review L4): previews nobody executed are worthless after a day.
    await t.query("delete from plans where status = 'created' and expires_at < $1", [
      new Date(now - 24 * 3_600_000).toISOString(),
    ]);
    await t.query(
      "insert into plans (id, user_id, action, symbol, params, items, input_hash, summary, created_at, expires_at) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)",
      [
        id,
        userId,
        plan.action,
        plan.symbol,
        JSON.stringify(params),
        JSON.stringify(plan.items),
        itemsHash(plan.items),
        JSON.stringify(summary),
        new Date(now).toISOString(),
        expiresAt,
      ],
    );
    await record(t, summary);
  });
  return summary;
}

/** Everything a stored plan can hold: changes to positions (modify/close/cancel) or new entries (market/pending). */
export type StoredItem = PlanItem | EntryItem | LadderItem;
export const isPlanItem = (i: StoredItem): i is PlanItem =>
  i.op === "modify" || i.op === "close" || i.op === "cancel";

export interface StoredPlan {
  readonly id: string;
  readonly status: "created" | "executing" | "executed" | "expired";
  readonly summary: PlanSummary;
  readonly items: readonly StoredItem[];
  readonly inputHash: string;
  readonly expiresAt: number;
}

export async function loadPlan(db: Db, userId: string, id: string): Promise<StoredPlan | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.query<{
    id: string;
    status: StoredPlan["status"];
    summary: PlanSummary;
    items: StoredItem[];
    input_hash: string;
    expires_at: Date | string;
  }>("select id, status, summary, items, input_hash, expires_at from plans where id = $1 and user_id = $2", [
    id,
    userId,
  ]);
  if (row === undefined) return null;
  return {
    id: row.id,
    status: row.status,
    summary: row.summary,
    items: row.items,
    inputHash: row.input_hash,
    expiresAt: (row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)).getTime(),
  };
}
