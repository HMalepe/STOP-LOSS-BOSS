/**
 * Entry plans (docs/03 §5, §9): bulk market entries and pending ladders, as stored plans like any other.
 * Preview reads fresh account, quote (with its tick value), spec and positions in parallel, builds with the pure domain builders,
 * asks the broker for margin (R9.3, ≤ 2 calls), records the spread, then stores the exact items with a batch number (R9.1) in one
 * transaction with its audit row. Execute (executions.ts) re-checks the market, the spread and the margin before anything is sent.
 */
import { z } from "zod";
import { buildMarketBatch, type EntryDraft, type EntryItem, type MarketBatchRequest } from "@/domain/entries";
import { buildLadder, type LadderDraft, type LadderItem, type LadderRequest } from "@/domain/ladder";
import { netMargin, marginVerdict, type MarginVerdict } from "@/domain/margin";
import type { PlanError } from "@/domain/plan";
import { spreadVerdict } from "@/domain/spreadGuard";
import type { Position, Quote, SymbolSpec } from "@/domain/types";
import type { AccountInfo } from "@/broker/BrokerProvider";
import type { Db } from "../db/sql";
import {
  itemsHash,
  MAX_QUOTE_AGE_MS,
  PLAN_TTL_MS,
  type CreatePlanResult,
  type EntrySummary,
  type PlanSummary,
} from "./plans";
import { SpreadSampler } from "./spread";
import type { TradingServices } from "./services";
import { randomUUID } from "node:crypto";

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");
const POINTS = z.number().int().min(1).max(1_000_000);
const PRICE = z.number().positive();
const LOT = z.number().positive().max(10_000);

const levelSpec = z.union([
  z.strictObject({ mode: z.literal("points"), points: POINTS }),
  z.strictObject({ mode: z.literal("price"), price: PRICE }),
]);

const marketBody = z.strictObject({
  action: z.literal("market"),
  symbol: SYMBOL,
  side: z.enum(["BUY", "SELL"]),
  count: z.number().int().min(1).max(1_000),
  volume: LOT,
  sl: levelSpec.optional(),
  tp: levelSpec.optional(),
  noStop: z.boolean().optional(),
});

const ladderBody = z.strictObject({
  action: z.literal("ladder"),
  symbol: SYMBOL,
  type: z.enum(["BUY_LIMIT", "BUY_STOP", "SELL_LIMIT", "SELL_STOP"]),
  from: PRICE,
  to: PRICE,
  spacing: z.union([
    z.strictObject({ kind: z.literal("levels"), levels: z.number().int().min(1).max(1_000) }),
    z.strictObject({ kind: z.literal("step"), stepPoints: POINTS }),
  ]),
  lots: z.union([
    z.strictObject({ kind: z.literal("flat"), volume: LOT }),
    z.strictObject({ kind: z.literal("scaled"), start: LOT, end: LOT }),
  ]),
  slPoints: POINTS.optional(),
  tpPoints: POINTS.optional(),
  noStop: z.boolean().optional(),
  /** R9.12: always explicit. GTC is an opt-in, flagged in the preview. */
  expiry: z.union([
    z.strictObject({ type: z.literal("DAY") }),
    z.strictObject({ type: z.literal("GTC") }),
    z.strictObject({ type: z.literal("SPECIFIED"), time: z.iso.datetime() }),
  ]),
});

export const entryBody = z.discriminatedUnion("action", [marketBody, ladderBody]);
export type EntryBody = z.infer<typeof entryBody>;
export const ENTRY_ACTIONS: ReadonlySet<string> = new Set(["market", "ladder"]);

/** exactOptionalPropertyTypes: drop `undefined` keys rather than pass them on. */
function marketRequest(b: z.infer<typeof marketBody>): MarketBatchRequest {
  return {
    symbol: b.symbol,
    side: b.side,
    count: b.count,
    volume: b.volume,
    ...(b.sl === undefined ? {} : { sl: b.sl }),
    ...(b.tp === undefined ? {} : { tp: b.tp }),
    ...(b.noStop === undefined ? {} : { noStop: b.noStop }),
  };
}
function ladderRequest(b: z.infer<typeof ladderBody>): LadderRequest {
  return {
    symbol: b.symbol,
    type: b.type,
    from: b.from,
    to: b.to,
    spacing: b.spacing,
    lots: b.lots,
    expiry: b.expiry,
    ...(b.slPoints === undefined ? {} : { slPoints: b.slPoints }),
    ...(b.tpPoints === undefined ? {} : { tpPoints: b.tpPoints }),
    ...(b.noStop === undefined ? {} : { noStop: b.noStop }),
  };
}

/** Existing same-symbol volume: the margin call is standalone, so we ask for existing+new and existing-only and take the difference (R9.3). */
export async function entryMargin(
  svc: TradingServices,
  positions: readonly Position[],
  a: {
    readonly symbol: string;
    readonly side: "BUY" | "SELL";
    readonly price: number;
    readonly totalLots: number;
    readonly account: AccountInfo;
    readonly totalRisk: number | null;
  },
): Promise<MarginVerdict> {
  const existing = Number(
    positions
      .filter((p) => p.symbol === a.symbol)
      .reduce((s, p) => s + p.volume, 0)
      .toFixed(8),
  );
  const [withNew, existingOnly] = await Promise.all([
    svc.broker.calculateMargin({
      symbol: a.symbol,
      side: a.side,
      volume: Number((existing + a.totalLots).toFixed(8)),
      price: a.price,
    }),
    existing > 0
      ? svc.broker.calculateMargin({ symbol: a.symbol, side: a.side, volume: existing, price: a.price })
      : Promise.resolve(0),
  ]);
  return marginVerdict({
    required: netMargin(withNew, existingOnly),
    freeMargin: a.account.freeMargin,
    equity: a.account.equity,
    usedMargin: a.account.margin,
    totalRisk: a.totalRisk,
    stopOutPct: null,
  });
}

type Built =
  | { readonly kind: "market"; readonly draft: EntryDraft }
  | { readonly kind: "ladder"; readonly draft: LadderDraft };

export interface EntryContext {
  readonly account: AccountInfo;
  readonly quote: Quote;
  readonly spec: SymbolSpec;
  readonly positions: readonly Position[];
}

export async function loadEntryContext(svc: TradingServices, symbol: string): Promise<EntryContext> {
  const [account, quote, spec, positions] = await Promise.all([
    svc.broker.getAccount(),
    svc.broker.getQuote(symbol),
    svc.specs.get(symbol),
    svc.broker.getPositions(),
  ]);
  svc.entry.sampler.record(quote, spec, svc.clock.now());
  return { account, quote, spec, positions };
}

const blocked = (error: PlanError): CreatePlanResult => ({ ok: false, error });

export async function createEntryPlan(
  svc: TradingServices,
  db: Db,
  userId: string,
  body: EntryBody,
  record: (tx: Db, summary: PlanSummary) => Promise<unknown>,
): Promise<CreatePlanResult> {
  const ctx = await loadEntryContext(svc, body.symbol);
  const now = svc.clock.now();
  if (now - ctx.quote.time > MAX_QUOTE_AGE_MS) {
    return {
      ok: false,
      error: {
        code: "PRICE_STALE",
        message: "The last price is too old to check against (market closed or feed lagging). Try again.",
      },
    };
  }
  const acct = {
    equity: ctx.account.equity,
    hedging: ctx.account.marginMode === "HEDGING",
    commissionPerLot: svc.entry.commissionPerLot,
  };
  const snap = { spec: ctx.spec, quote: ctx.quote };
  const r =
    body.action === "market"
      ? buildMarketBatch(marketRequest(body), snap, svc.entry.caps, acct)
      : buildLadder(ladderRequest(body), snap, svc.entry.caps, acct);
  if (!r.ok) return blocked(r.error);
  const built: Built =
    body.action === "market"
      ? { kind: "market", draft: r.plan as EntryDraft }
      : { kind: "ladder", draft: r.plan as LadderDraft };
  const d = built.draft;

  // R9.3 margin.
  const probe =
    built.kind === "market"
      ? {
          side: built.draft.side,
          price: built.draft.side === "BUY" ? built.draft.quote.ask : built.draft.quote.bid,
        }
      : { side: built.draft.marginProbe.type, price: built.draft.marginProbe.price };
  const totalRisk = d.risk.total;
  const margin = await entryMargin(svc, ctx.positions, {
    symbol: d.symbol,
    side: probe.side,
    price: probe.price,
    totalLots: d.totalLots,
    account: ctx.account,
    totalRisk,
  });
  if (!margin.ok) {
    return margin.code === "MARGIN_UNVERIFIED"
      ? blocked({ code: "BROKER_UNAVAILABLE", message: margin.message, details: ["margin"] })
      : blocked({
          code: "PLAN_INVALID",
          message: margin.message,
          details: [{ rule: "R9.3", side: d.side, count: d.items.length, message: margin.message }],
        });
  }

  // R9.4: informational now (execute enforces it): "spread now X pts, normal Y pts".
  const current = SpreadSampler.points(ctx.quote, ctx.spec);
  const sv = spreadVerdict(current, svc.entry.sampler.samples(d.symbol, now), svc.entry.spread);
  const warnings = [
    ...d.warnings,
    ...margin.warnings,
    ...(sv.ok
      ? sv.warning === undefined
        ? []
        : [sv.warning]
      : [`${sv.message} Confirming now would be refused.`]),
  ];

  const id = randomUUID();
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();
  const entry: EntrySummary = {
    kind: built.kind,
    side: d.side,
    totalLots: d.totalLots,
    risk: { total: d.risk.total, unlimited: d.risk.unlimited, pctOfEquity: d.risk.pctOfEquity },
    margin: { required: margin.required, freeMargin: ctx.account.freeMargin },
    spread: { nowPoints: current, normalPoints: sv.normal },
    ...(built.kind === "ladder"
      ? {
          expiry: built.draft.expiry,
          requestedLevels: built.draft.requestedLevels,
          duplicatesRemoved: built.draft.duplicatesRemoved,
        }
      : {}),
  };
  const items: readonly (EntryItem | LadderItem)[] = d.items;
  const summary: PlanSummary = {
    id,
    action: built.kind,
    symbol: d.symbol,
    expiresAt,
    quote: { bid: d.quote.bid, ask: d.quote.ask, time: new Date(d.quote.time).toISOString() },
    count: items.length,
    skipped: [],
    breakdown: {
      buys: d.side === "BUY" ? items.length : 0,
      sells: d.side === "SELL" ? items.length : 0,
      totalLots: d.totalLots,
      ...(built.kind === "ladder" ? { prices: built.draft.items.map((i) => i.price) } : {}),
    },
    warnings,
    mode: svc.mode,
    entry,
  };
  await db.tx(async (t) => {
    await t.query("delete from plans where status = 'created' and expires_at < $1", [
      new Date(now - 24 * 3_600_000).toISOString(),
    ]);
    // R9.1: the batch number is allocated here, atomically, so a batch keeps its identity.
    const [seq] = await t.query<{ n: string | number }>("select nextval('batch_seq') as n");
    const batchSeq = Number(seq?.n);
    const withSeq: PlanSummary = { ...summary, entry: { ...entry, batchSeq } };
    await t.query(
      "insert into plans (id, user_id, action, symbol, params, items, input_hash, summary, created_at, expires_at, batch_seq) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)",
      [
        id,
        userId,
        built.kind,
        d.symbol,
        JSON.stringify(body),
        JSON.stringify(items),
        itemsHash(items),
        JSON.stringify(withSeq),
        new Date(now).toISOString(),
        expiresAt,
        batchSeq,
      ],
    );
    await record(t, withSeq);
  });
  const finalSummary =
    (await db.query<{ summary: PlanSummary }>("select summary from plans where id = $1", [id]))[0]?.summary ??
    summary;
  return { ok: true, summary: finalSummary };
}
