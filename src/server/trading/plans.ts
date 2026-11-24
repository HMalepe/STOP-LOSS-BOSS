/**
 * Plans (docs/04, non-negotiable 1: preview before execute).
 * A plan is built from a FRESH snapshot by the pure domain builder, then stored with its exact items, a hash of them,
 * and a 30 s expiry. Execute (M3) runs the stored items, never anything from a request, and refuses if the hash no
 * longer matches what was stored.
 */
import { randomUUID } from "node:crypto";
import { effectiveCaps } from "../caps";
import { z } from "zod";
import { buildPlan, type PlanDraft, type PlanError, type PlanRequest } from "@/domain/plan";
import {
  buildLadder,
  buildMarketBatch,
  type BatchIdentity,
  type MarketEntryItem,
  type PendingEntryItem,
} from "@/domain/entries";
import { riskToStop } from "@/domain/risk";
import type { PlanItem, Position, Quote, Skipped, SymbolSpec } from "@/domain/types";
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

const SIDE = z.enum(["BUY", "SELL"]);
const ENTRY_LEVEL = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("points"), value: z.number() }),
  z.strictObject({ kind: z.literal("price"), value: z.number() }),
]);

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
  // Order Desk (Phase 08). Values are range-checked by the domain builder (R0.6), which says what's wrong in words.
  z.strictObject({
    action: z.literal("market"),
    symbol: SYMBOL,
    side: SIDE,
    count: z.number(),
    volume: z.number(),
    stopLoss: ENTRY_LEVEL.optional(),
    takeProfit: ENTRY_LEVEL.optional(),
  }),
  z.strictObject({
    action: z.literal("ladder"),
    symbol: SYMBOL,
    side: SIDE,
    kind: z.enum(["limit", "stop"]),
    from: z.number(),
    to: z.number(),
    spacing: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("count"), levels: z.number() }),
      z.strictObject({ mode: z.literal("step"), points: z.number() }),
    ]),
    lots: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("flat"), lot: z.number() }),
      z.strictObject({ mode: z.literal("scaled"), start: z.number(), end: z.number() }),
    ]),
    slOffsetPoints: z.number().optional(),
    tpOffsetPoints: z.number().optional(),
  }),
]);
export type PlanBody = z.infer<typeof planBody>;
export const LATER_ACTIONS = new Set(["cancel"]);
export type EntryBody = Extract<PlanBody, { action: "market" | "ladder" }>;
export type ManageBody = Exclude<PlanBody, EntryBody>;

/** What a stored plan can hold: management items, or Order Desk entries. */
export type StoredItem = PlanItem | MarketEntryItem | PendingEntryItem;
export type StoredAction = PlanDraft["action"] | "market" | "ladder";

/** Anything storePlan can record. PlanDraft for management; entries build one of these directly. */
export interface StorableDraft extends Omit<PlanDraft, "action" | "items"> {
  readonly action: StoredAction;
  readonly items: readonly StoredItem[];
  readonly risk?: RiskPreview;
}

export interface PlanSummary {
  readonly id: string;
  readonly action: StoredAction;
  readonly symbol: string;
  readonly expiresAt: string;
  readonly quote: { readonly bid: number; readonly ask: number; readonly time: string } | null;
  readonly count: number;
  readonly skipped: readonly Skipped[];
  readonly breakdown: PlanDraft["breakdown"] & { readonly totalLots?: number };
  readonly warnings: readonly string[];
  readonly mode: TradingMode;
  /** Order Desk entries only: money at risk to SL (R9.2) and margin (R9.3), as shown before confirm (OD6). */
  readonly risk?: RiskPreview;
}

export interface RiskPreview {
  readonly currency: string;
  readonly toStop: number;
  readonly pctOfEquity: number;
  readonly capPct: number;
  readonly marginRequired: number;
  readonly freeMargin: number;
}

export type CreatePlanResult =
  | { readonly ok: true; readonly summary: PlanSummary }
  | {
      readonly ok: false;
      readonly error: PlanError | { readonly code: "PRICE_STALE"; readonly message: string };
    };

/** Strip `undefined` optionals so the domain type (exactOptionalPropertyTypes) is met exactly. */
function toRequest(body: ManageBody): PlanRequest {
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
export function itemsHash(items: readonly StoredItem[]): string {
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
  if (body.action === "market" || body.action === "ladder") {
    return createEntryPlan(svc, db, userId, body, record);
  }
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
  // Close-now never comes through here: it's exempt from this cap (it's how you get flat).
  const limit = (await effectiveCaps(db, svc.capCeilings)).maxPositionsPerBatch;
  if (built.plan.items.length > limit) {
    return {
      ok: false,
      error: {
        code: "PLAN_INVALID",
        message: `That's ${String(built.plan.items.length)} positions; one action may change at most ${String(limit)}. Narrow the filter (side, magic) or raise the cap in Settings (up to ${String(svc.capCeilings.maxPositionsPerBatch)}).`,
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
  plan: StorableDraft,
  params: unknown,
  positions: readonly Position[],
  record: (tx: Db, summary: PlanSummary) => Promise<unknown>,
): Promise<PlanSummary> {
  const now = svc.clock.now();
  const byId = new Map(positions.map((p) => [p.id, p.volume]));
  const lots = plan.items.reduce(
    (a, i) =>
      i.op === "close"
        ? a + (byId.get(i.positionId) ?? 0)
        : i.op === "market" || i.op === "pending"
          ? a + i.volume
          : a,
    0,
  );
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
    ...(plan.risk === undefined ? {} : { risk: plan.risk }),
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

/** R9.1: one fresh batch per preview. magic = prefix × 10^9 + seq; the short tag is seq in base 36 (≤ 6 chars). */
export async function allocateBatch(db: Db, prefix: number): Promise<BatchIdentity> {
  const [row] = await db.query<{ seq: string | number }>("select nextval('batch_seq') as seq");
  const seq = Number(row?.seq);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("batch sequence returned no value");
  const short = seq.toString(36);
  return { magic: prefix * 1_000_000_000 + seq, batchShort: short, planShort: short };
}

const ENTRIES_NEED_HEDGING =
  "Order Desk entries need a hedging account: on a netting account N orders would merge into one position (R0.2).";

/**
 * OD1 / OD2 preview. Checks in order, all before anything is stored: hedging account (R0.2), fresh quote (R7.2), the
 * domain build (R5.x, R9.1, caps from Settings). The batch number is only taken once the request is otherwise valid.
 */
async function createEntryPlan(
  svc: TradingServices,
  db: Db,
  userId: string,
  body: EntryBody,
  record: (tx: Db, summary: PlanSummary) => Promise<unknown>,
): Promise<CreatePlanResult> {
  const [account, quote, spec] = await Promise.all([
    svc.broker.getAccount(),
    svc.broker.getQuote(body.symbol),
    svc.specs.get(body.symbol),
  ]);
  if (account.marginMode !== "HEDGING") {
    return { ok: false, error: { code: "PLAN_INVALID", message: ENTRIES_NEED_HEDGING, details: [] } };
  }
  if (svc.clock.now() - quote.time > MAX_QUOTE_AGE_MS) {
    return {
      ok: false,
      error: {
        code: "PRICE_STALE",
        message: "The last price is too old to fire against (market closed or feed lagging). Try again.",
      },
    };
  }
  const caps = await effectiveCaps(db, svc.capCeilings);
  const id = await allocateBatch(db, svc.magicPrefix);
  const built =
    body.action === "market"
      ? buildMarketBatch(
          {
            symbol: body.symbol,
            side: body.side,
            count: body.count,
            volume: body.volume,
            stopLoss: body.stopLoss,
            takeProfit: body.takeProfit,
          },
          { spec, quote },
          id,
          caps,
        )
      : buildLadder(
          {
            symbol: body.symbol,
            side: body.side,
            kind: body.kind,
            from: body.from,
            to: body.to,
            spacing: body.spacing,
            lots: body.lots,
            slOffsetPoints: body.slOffsetPoints,
            tpOffsetPoints: body.tpOffsetPoints,
          },
          { spec, quote },
          id,
          caps,
        );
  if (!built.ok) {
    const e = built.error;
    return { ok: false, error: e.code === "PLAN_INVALID" ? { ...e, details: [] } : e };
  }
  const p = built.plan;
  const checked = await checkRiskAndMargin(svc, account, spec, quote, p.items, caps.maxRiskPct);
  if (!checked.ok) return { ok: false, error: checked.error };
  const draft: StorableDraft = {
    risk: checked.risk,
    action: body.action,
    symbol: p.symbol,
    quote: p.quote,
    items: p.items,
    skipped: [],
    breakdown: { buys: p.side === "BUY" ? p.items.length : 0, sells: p.side === "SELL" ? p.items.length : 0 },
    warnings: p.warnings,
  };
  const summary = await storePlan(
    svc,
    db,
    userId,
    draft,
    { ...body, batch: { magic: id.magic, tag: id.batchShort } },
    [],
    record,
  );
  return { ok: true, summary };
}

const money = (n: number, currency: string) => `${n.toFixed(2)} ${currency}`;

/**
 * OD6 / R9.2 / R9.3, before anything is stored:
 * - risk to SL must be bounded (every order has an SL) and within the cap (% of equity, from Settings);
 * - the broker's margin for the whole batch must fit in free margin. Margin is asked once per distinct lot at the
 *   batch's worst-case price (highest for buys: margin grows with price on FX majors), not once per order.
 * Anything the broker can't tell us blocks: never estimated (R9.2 "never guess", R9.3).
 */
async function checkRiskAndMargin(
  svc: TradingServices,
  account: { readonly equity: number; readonly freeMargin: number; readonly currency: string },
  spec: SymbolSpec,
  quote: Quote,
  items: readonly (MarketEntryItem | PendingEntryItem)[],
  capPct: number,
): Promise<{ ok: true; risk: RiskPreview } | { ok: false; error: PlanError }> {
  const invalid = (message: string) => ({
    ok: false as const,
    error: { code: "PLAN_INVALID" as const, message, details: [] },
  });
  const risk = riskToStop(items, spec, quote);
  if (!risk.ok) {
    return { ok: false, error: { code: "BROKER_UNAVAILABLE", message: risk.message, details: [] } };
  }
  if (risk.total === null) {
    return invalid(
      `No stop loss means the risk can't be capped (your cap is ${String(capPct)}% of equity). Set an SL to fire this batch.`,
    );
  }
  if (!(account.equity > 0)) return invalid("Equity is zero: nothing can be risked.");
  const limit = (account.equity * capPct) / 100;
  if (risk.total > limit + 1e-9) {
    return invalid(
      `Risk to SL is ${money(risk.total, account.currency)}, over your cap of ${String(capPct)}% of equity (${money(limit, account.currency)}).`,
    );
  }

  const side =
    items[0]?.op === "market" ? items[0].side : items[0]?.type.startsWith("BUY") === true ? "BUY" : "SELL";
  const worst = Math.max(
    ...items.map((i) => (i.op === "pending" ? i.openPrice : i.side === "BUY" ? quote.ask : quote.bid)),
  );
  const byLot = new Map<number, number>();
  for (const i of items) byLot.set(i.volume, (byLot.get(i.volume) ?? 0) + 1);
  let required = 0;
  for (const [volume, count] of byLot) {
    const m = await svc.broker.calculateMargin({ symbol: spec.symbol, side, volume, openPrice: worst });
    if (m === null) {
      return invalid(
        "The broker can't calculate the margin for this batch right now, so it can't be checked. Nothing was stored.",
      );
    }
    required += m * count;
  }
  required = Math.round(required * 100) / 100;
  if (required > account.freeMargin) {
    return invalid(
      `This batch needs ${money(required, account.currency)} margin; free margin is ${money(account.freeMargin, account.currency)}.`,
    );
  }
  return {
    ok: true,
    risk: {
      currency: account.currency,
      toStop: risk.total,
      pctOfEquity: Math.round((risk.total / account.equity) * 10_000) / 100,
      capPct,
      marginRequired: required,
      freeMargin: account.freeMargin,
    },
  };
}
