/**
 * Order Desk entries, OD1 bulk market orders (03-TRADING-RULES §5, §9; docs/11).
 *
 * Request + spec + quote → the exact market orders to send, or a coded reason not to. Pure: no I/O, no clock, never throws
 * on bad input (R0.6). Identity (magic, short ids) is allocated by the server and passed in.
 *
 * Safety properties, each tested:
 * - Non-negotiable 9: a requested stop is never dropped. If it can't be placed validly, the WHOLE plan is refused;
 *   there is no "send without the SL" path.
 * - R5.3: levels are validated against the closing side (buy → bid, sell → ask), because that is what the broker
 *   checks a stop against; points are measured from the expected fill (buy → ask, sell → bid).
 * - R5.1 / R5.2: lots round down to the step, never up; count and total lots are capped.
 */
import {
  formatPrice,
  fromPoints,
  points,
  roundToTickPoints,
  specProblems,
  tryRoundToTickPoints,
} from "./price";
import {
  checkLevel,
  marketFrom,
  quoteProblems,
  type LevelKind,
  type LevelViolation,
  type Market,
} from "./rules";
import type { Points, Price, Quote, Side, SymbolSpec } from "./types";

/** SL/TP as a distance from the expected fill, or an absolute price. */
export type EntryLevel =
  { readonly kind: "points"; readonly value: number } | { readonly kind: "price"; readonly value: number };

export interface MarketBatchRequest {
  readonly symbol: string;
  readonly side: Side;
  readonly count: number;
  readonly volume: number;
  readonly stopLoss?: EntryLevel | undefined;
  readonly takeProfit?: EntryLevel | undefined;
}

/** R9.1, allocated by the server: magic = APP_MAGIC_PREFIX × 10^9 + batchSeq. */
export interface BatchIdentity {
  readonly magic: number;
  /** "OD:" + batchShort is the comment humans see in MT5. */
  readonly batchShort: string;
  /** clientId = planShort + item index (R6.5 reconciliation key). */
  readonly planShort: string;
}

export interface EntryCaps {
  readonly maxOrdersPerAction: number;
  readonly maxTotalLots: number;
}

export interface MarketEntryItem {
  readonly op: "market";
  readonly symbol: string;
  readonly side: Side;
  readonly volume: number;
  readonly sl: Price | null;
  readonly tp: Price | null;
  readonly magic: number;
  readonly comment: string;
  readonly clientId: string;
}

export interface MarketBatchPlan {
  readonly symbol: string;
  readonly side: Side;
  readonly count: number;
  /** Effective lot per order after R5.1 rounding. */
  readonly volume: number;
  readonly totalLots: number;
  readonly quote: { readonly bid: Price; readonly ask: Price; readonly time: number };
  readonly items: readonly MarketEntryItem[];
  readonly warnings: readonly string[];
}

export type EntryError =
  | { readonly code: "VALIDATION"; readonly message: string }
  | { readonly code: "BROKER_UNAVAILABLE"; readonly message: string; readonly details: readonly string[] }
  | { readonly code: "PLAN_INVALID"; readonly message: string; readonly details: readonly LevelViolation[] };

export type MarketBatchResult =
  { readonly ok: true; readonly plan: MarketBatchPlan } | { readonly ok: false; readonly error: EntryError };

/** MetaApi: comment + clientId ≤ 26 characters (R9.1, verified). */
export const MAX_TAG_CHARS = 26;
/** R0.6: point distances are integers ≤ 1,000,000. */
const MAX_POINTS = 1_000_000;

const fail = (error: EntryError): MarketBatchResult => ({ ok: false, error });
const invalid = (message: string): MarketBatchResult => fail({ code: "VALIDATION", message });

/** R5.1: whole steps, rounded down, computed on integers (0.07 / 0.01 is 7.000000000000001 in floats). */
function stepsDown(volume: number, step: number): number {
  return Math.floor(volume / step + 1e-9);
}
const lots = (steps: number, step: number) => Number((steps * step).toFixed(8));

export function buildMarketBatch(
  req: MarketBatchRequest,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
  id: BatchIdentity,
  caps: EntryCaps,
): MarketBatchResult {
  // R0.1: no trustworthy market data, no plan. Never a fallback.
  const dataProblems = [
    ...(snap.spec === null ? ["no symbol specification"] : specProblems(snap.spec)),
    ...(snap.quote === null ? ["no live price"] : quoteProblems(snap.quote)),
  ];
  if (snap.spec === null || snap.quote === null || dataProblems.length > 0) {
    return fail({
      code: "BROKER_UNAVAILABLE",
      message: "Market data for this symbol isn't usable right now.",
      details: dataProblems,
    });
  }
  const spec = snap.spec;
  if (spec.symbol !== req.symbol || snap.quote.symbol !== req.symbol) {
    return invalid(`Market data is for ${spec.symbol}, the order is for ${req.symbol}.`);
  }
  if (!Number.isSafeInteger(req.count) || req.count < 1) return invalid("Count must be a whole number ≥ 1.");
  if (req.count > caps.maxOrdersPerAction) {
    return invalid(
      `${String(req.count)} orders is over your cap of ${String(caps.maxOrdersPerAction)} per action.`,
    );
  }

  // R5.1
  if (!Number.isFinite(req.volume) || req.volume <= 0) return invalid("Lot size must be a positive number.");
  const steps = stepsDown(req.volume, spec.volumeStep);
  const volume = lots(steps, spec.volumeStep);
  if (volume < spec.volumeMin || volume > spec.volumeMax) {
    return invalid(
      `Lot ${String(volume)} is outside ${String(spec.volumeMin)}–${String(spec.volumeMax)} for ${spec.symbol}.`,
    );
  }
  const warnings: string[] = [];
  if (stepsDown(req.volume, spec.volumeStep) * spec.volumeStep + 1e-9 < req.volume) {
    warnings.push(`Lot rounded down to ${String(volume)} (step ${String(spec.volumeStep)}).`);
  }
  // R5.2, on integer steps so 10 × 0.5 compares exactly.
  const totalLots = lots(steps * req.count, spec.volumeStep);
  if (totalLots > caps.maxTotalLots + 1e-9) {
    return invalid(`${String(totalLots)} lots in total is over your cap of ${String(caps.maxTotalLots)}.`);
  }

  // R9.1: the longest clientId is the last one.
  const comment = `OD:${id.batchShort}`;
  if (comment.length + `${id.planShort}${String(req.count - 1)}`.length > MAX_TAG_CHARS) {
    return invalid("Batch tag too long for MetaApi (comment + clientId > 26 characters).");
  }
  if (!Number.isSafeInteger(id.magic) || id.magic <= 0) {
    return invalid("Batch magic must be a positive safe integer.");
  }

  const m = marketFrom(spec, snap.quote);
  const sl = resolveLevel(req.side, "SL", req.stopLoss, m);
  if (typeof sl === "string") return invalid(sl);
  const tp = resolveLevel(req.side, "TP", req.takeProfit, m);
  if (typeof tp === "string") return invalid(tp);

  // R5.3 / non-negotiable 9: any invalid requested level refuses the whole plan.
  const violations = [
    ...(sl === null ? [] : [checkLevel(req.side, "SL", sl, m)]),
    ...(tp === null ? [] : [checkLevel(req.side, "TP", tp, m)]),
  ].filter((v): v is LevelViolation => v !== null);
  if (violations.length > 0) {
    return fail({
      code: "PLAN_INVALID",
      message: violations
        .map(
          (v) =>
            `${v.level} must be ${v.relation} ${formatPrice(fromPoints(v.boundary, spec), spec)} (${v.rule}).`,
        )
        .join(" "),
      details: violations,
    });
  }
  if (sl === null) warnings.push("No stop loss: the loss on these orders is limited only by your account.");

  const slPrice = sl === null ? null : fromPoints(sl, spec);
  const tpPrice = tp === null ? null : fromPoints(tp, spec);
  const items: MarketEntryItem[] = Array.from({ length: req.count }, (_, i) => ({
    op: "market",
    symbol: req.symbol,
    side: req.side,
    volume,
    sl: slPrice,
    tp: tpPrice,
    magic: id.magic,
    comment,
    clientId: `${id.planShort}${String(i)}`,
  }));
  return {
    ok: true,
    plan: {
      symbol: req.symbol,
      side: req.side,
      count: req.count,
      volume,
      totalLots,
      quote: { bid: fromPoints(m.bid, spec), ask: fromPoints(m.ask, spec), time: snap.quote.time },
      items,
      warnings,
    },
  };
}

/** A requested level in points, or null if none requested, or a message if the input is unusable. */
function resolveLevel(
  side: Side,
  kind: LevelKind,
  level: EntryLevel | undefined,
  m: Market,
): Points | null | string {
  if (level === undefined) return null;
  if (level.kind === "price") {
    return tryRoundToTickPoints(level.value, m.spec) ?? `${kind} price must be a finite number.`;
  }
  if (!Number.isSafeInteger(level.value) || level.value < 1 || level.value > MAX_POINTS) {
    return `${kind} distance must be a whole number of points between 1 and ${String(MAX_POINTS)}.`;
  }
  // R5.3: from the expected fill. Below the fill for a buy's SL / a sell's TP, above otherwise.
  const fill = side === "BUY" ? m.ask : m.bid;
  const down = (side === "BUY") === (kind === "SL");
  const raw = down ? fill - level.value : fill + level.value;
  // On a coarse tick (US30) snap to the grid. raw is a safe integer near a valid quote, so this can't fail;
  // if it ever did, throwing beats sending a silently wrong stop.
  return roundToTickPoints(fromPoints(points(raw), m.spec), m.spec);
}
