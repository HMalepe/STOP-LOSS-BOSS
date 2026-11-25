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
  tickPoints,
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
import type { PendingType, Points, Price, Quote, Side, SymbolSpec } from "./types";

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

/** Most orders one batch may carry: the clientId index is exactly 3 digits (R9.1). */
export const MAX_BATCH_ORDERS = 1000;

/**
 * R9.1: every id of a batch derives from its sequence number.
 *   magic    = prefix × 10^9 + seq        (seq < 10^9, so the result stays below 2^53)
 *   comment  = "OD:" + base36(seq)
 *   clientId = base36(seq) + index as exactly 3 digits
 * The index is fixed-width, so the last 3 characters are always the index and the rest is always the seq: two
 * different batches can never produce the same clientId. (Unpadded, seq 10 item 10 and seq 361 item 0 are both "a10".)
 */
export function identityFromSeq(prefix: number, seq: number): BatchIdentity {
  if (!Number.isSafeInteger(prefix) || prefix < 1) {
    throw new RangeError("magic prefix must be a positive integer");
  }
  if (!Number.isSafeInteger(seq) || seq < 1 || seq >= 1_000_000_000) {
    throw new RangeError("batch seq out of range");
  }
  const short = seq.toString(36);
  return { magic: prefix * 1_000_000_000 + seq, batchShort: short, planShort: short };
}

export const entryClientId = (id: BatchIdentity, index: number): string =>
  `${id.planShort}${String(index).padStart(3, "0")}`;

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

const fail = (error: EntryError): { readonly ok: false; readonly error: EntryError } => ({
  ok: false,
  error,
});
const invalid = (message: string) => fail({ code: "VALIDATION", message });

/** R0.1: no trustworthy market data, no plan. Never a fallback. */
function checkData(
  symbol: string,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
):
  | { readonly ok: true; readonly spec: SymbolSpec; readonly quote: Quote }
  | { readonly ok: false; readonly error: EntryError } {
  const problems = [
    ...(snap.spec === null ? ["no symbol specification"] : specProblems(snap.spec)),
    ...(snap.quote === null ? ["no live price"] : quoteProblems(snap.quote)),
  ];
  if (snap.spec === null || snap.quote === null || problems.length > 0) {
    return fail({
      code: "BROKER_UNAVAILABLE",
      message: "Market data for this symbol isn't usable right now.",
      details: problems,
    });
  }
  if (snap.spec.symbol !== symbol || snap.quote.symbol !== symbol) {
    return invalid(`Market data is for ${snap.spec.symbol}, the order is for ${symbol}.`);
  }
  return { ok: true, spec: snap.spec, quote: snap.quote };
}

/** R9.1: magic sane, and comment + the longest clientId (the last index) fit MetaApi's 26 characters. */
function identityProblem(id: BatchIdentity, count: number): string | null {
  if (!Number.isSafeInteger(id.magic) || id.magic <= 0) return "Batch magic must be a positive safe integer.";
  if (count > MAX_BATCH_ORDERS) return `A batch can carry at most ${String(MAX_BATCH_ORDERS)} orders.`;
  if (`OD:${id.batchShort}`.length + entryClientId(id, count - 1).length > MAX_TAG_CHARS) {
    return "Batch tag too long for MetaApi (comment + clientId > 26 characters).";
  }
  return null;
}

const NO_SL_WARNING = "No stop loss: the loss on these orders is limited only by your account.";

/** R5.1: the step count if `volume` is exactly on the grid (within 1e-9 of a whole step), else null. */
function gridSteps(volume: number, step: number): number | null {
  const n = volume / step;
  const r = Math.round(n);
  return Math.abs(n - r) < 1e-9 ? r : null;
}

const notOnGrid = (v: number, spec: SymbolSpec) =>
  `${String(v)} isn't a multiple of the lot step ${String(spec.volumeStep)}.`;

/** R5.1: min/max in lots (the minimum need not be a multiple of the step). */
function lotLimitProblem(volume: number, spec: SymbolSpec): string | null {
  return volume < spec.volumeMin - 1e-9 || volume > spec.volumeMax + 1e-9
    ? `Lot ${String(volume)} is outside ${String(spec.volumeMin)}–${String(spec.volumeMax)} for ${spec.symbol}.`
    : null;
}
const lots = (steps: number, step: number) => Number((steps * step).toFixed(8));

export function buildMarketBatch(
  req: MarketBatchRequest,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
  id: BatchIdentity,
  caps: EntryCaps,
): MarketBatchResult {
  const data = checkData(req.symbol, snap);
  if (!data.ok) return data;
  const { spec, quote } = data;
  if (!Number.isSafeInteger(req.count) || req.count < 1) return invalid("Count must be a whole number ≥ 1.");
  if (req.count > caps.maxOrdersPerAction) {
    return invalid(
      `${String(req.count)} orders is over your cap of ${String(caps.maxOrdersPerAction)} per action.`,
    );
  }

  // R5.1: a TYPED lot must be on the step grid. Refused, never silently rounded.
  if (!Number.isFinite(req.volume) || req.volume <= 0) return invalid("Lot size must be a positive number.");
  const steps = gridSteps(req.volume, spec.volumeStep);
  if (steps === null) return invalid(notOnGrid(req.volume, spec));
  const volume = lots(steps, spec.volumeStep);
  const outsideLimits = lotLimitProblem(volume, spec);
  if (outsideLimits !== null) return invalid(outsideLimits);
  const warnings: string[] = [];
  // R5.2, on integer steps so 10 × 0.5 compares exactly.
  const totalLots = lots(steps * req.count, spec.volumeStep);
  if (totalLots > caps.maxTotalLots + 1e-9) {
    return invalid(`${String(totalLots)} lots in total is over your cap of ${String(caps.maxTotalLots)}.`);
  }

  const tag = identityProblem(id, req.count);
  if (tag !== null) return invalid(tag);
  const comment = `OD:${id.batchShort}`;

  const m = marketFrom(spec, quote);
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
  if (sl === null) warnings.push(NO_SL_WARNING);

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
    clientId: entryClientId(id, i),
  }));
  return {
    ok: true,
    plan: {
      symbol: req.symbol,
      side: req.side,
      count: req.count,
      volume,
      totalLots,
      quote: { bid: fromPoints(m.bid, spec), ask: fromPoints(m.ask, spec), time: quote.time },
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

// ─── OD2: pending ladder (R5.4 – R5.6, R9.5) ─────────────────────────────────────────────────────────────────────

export interface LadderRequest {
  readonly symbol: string;
  readonly side: Side;
  /** limit: buy below / sell above the market. stop: buy above / sell below. */
  readonly kind: "limit" | "stop";
  /** A and B, prices. Levels run from A toward B. */
  readonly from: number;
  readonly to: number;
  readonly spacing:
    { readonly mode: "count"; readonly levels: number } | { readonly mode: "step"; readonly points: number };
  readonly lots:
    | { readonly mode: "flat"; readonly lot: number }
    /** R9.5: linear from start to end (increasing or decreasing). */
    | { readonly mode: "scaled"; readonly start: number; readonly end: number };
  /** R5.6: offsets in points from each level's own price. */
  readonly slOffsetPoints?: number | undefined;
  readonly tpOffsetPoints?: number | undefined;
}

export interface PendingEntryItem {
  readonly op: "pending";
  readonly symbol: string;
  readonly type: PendingType;
  readonly volume: number;
  readonly openPrice: Price;
  readonly sl: Price | null;
  readonly tp: Price | null;
  readonly magic: number;
  readonly comment: string;
  readonly clientId: string;
}

export interface LadderPlan {
  readonly symbol: string;
  readonly side: Side;
  readonly type: PendingType;
  readonly levels: number;
  readonly totalLots: number;
  readonly quote: { readonly bid: Price; readonly ask: Price; readonly time: number };
  readonly items: readonly PendingEntryItem[];
  readonly warnings: readonly string[];
}

export type LadderResult =
  { readonly ok: true; readonly plan: LadderPlan } | { readonly ok: false; readonly error: EntryError };

export function buildLadder(
  req: LadderRequest,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
  id: BatchIdentity,
  caps: EntryCaps,
): LadderResult {
  const data = checkData(req.symbol, snap);
  if (!data.ok) return data;
  const { spec, quote } = data;
  const m = marketFrom(spec, quote);
  const t = tickPoints(spec);
  const warnings: string[] = [];

  const a = tryRoundToTickPoints(req.from, spec);
  const b = tryRoundToTickPoints(req.to, spec);
  if (a === null || b === null || a <= 0 || b <= 0) return invalid("From and to must be positive prices.");
  for (const [name, v] of [
    ["SL", req.slOffsetPoints],
    ["TP", req.tpOffsetPoints],
  ] as const) {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > MAX_POINTS)) {
      return invalid(`${name} offset must be a whole number of points between 1 and ${String(MAX_POINTS)}.`);
    }
  }

  // R5.4: the level prices, in points, on the tick grid. Counts are capped BEFORE anything is built.
  let levels: number[];
  if (req.spacing.mode === "count") {
    const n = req.spacing.levels;
    if (!Number.isSafeInteger(n) || n < 1) return invalid("Levels must be a whole number ≥ 1.");
    if (n > caps.maxOrdersPerAction) return overCount(n, caps);
    const raw = Array.from({ length: n }, (_, i) => (n === 1 ? a : a + (i * (b - a)) / (n - 1)));
    levels = [...new Set(raw.map((v) => Math.round(v / t) * t))];
    if (levels.length < n) {
      warnings.push(
        `${String(n)} levels requested, ${String(levels.length)} distinct after rounding to the tick.`,
      );
    }
  } else {
    const k = req.spacing.points;
    if (!Number.isSafeInteger(k) || k < 1 || k > MAX_POINTS) {
      return invalid("Step must be a whole number of points ≥ 1.");
    }
    if (k % t !== 0) return invalid(`Step must be a multiple of the tick (${String(t)} points).`);
    const n = Math.floor(Math.abs(b - a) / k) + 1;
    if (n > caps.maxOrdersPerAction) return overCount(n, caps);
    const dir = b >= a ? 1 : -1;
    levels = Array.from({ length: n }, (_, i) => a + dir * i * k);
  }

  const tag = identityProblem(id, levels.length);
  if (tag !== null) return invalid(tag);

  // R9.5 / R5.1: per-level lots on integer steps, rounded down, never up.
  const lotSteps = ladderLots(req.lots, levels.length, spec);
  if (typeof lotSteps === "string") return invalid(lotSteps);
  const totalSteps = lotSteps.reduce((x, y) => x + y, 0);
  const totalLots = lots(totalSteps, spec.volumeStep);
  if (totalLots > caps.maxTotalLots + 1e-9) {
    return invalid(`${String(totalLots)} lots in total is over your cap of ${String(caps.maxTotalLots)}.`);
  }

  // R5.5 + R5.5b: every bad level is listed, and any one refuses the ladder.
  const type = pendingType(req.side, req.kind);
  const bad: string[] = [];
  const items: PendingEntryItem[] = [];
  for (const [i, p] of levels.entries()) {
    const placement = placementProblem(type, p, m);
    if (placement !== null) {
      bad.push(`${formatPrice(fromPoints(points(p), spec), spec)}: ${placement}`);
      continue;
    }
    // R5.6: buy SL below / TP above the level; sell the reverse. R5.5b: strictly more than d from the level.
    const sl =
      req.slOffsetPoints === undefined ? null : p + (req.side === "BUY" ? -1 : 1) * req.slOffsetPoints;
    const tp =
      req.tpOffsetPoints === undefined ? null : p + (req.side === "BUY" ? 1 : -1) * req.tpOffsetPoints;
    const tooClose = [
      ...(req.slOffsetPoints !== undefined && req.slOffsetPoints <= m.d ? ["SL"] : []),
      ...(req.tpOffsetPoints !== undefined && req.tpOffsetPoints <= m.d ? ["TP"] : []),
    ];
    if (tooClose.length > 0) {
      bad.push(
        `${formatPrice(fromPoints(points(p), spec), spec)}: ${tooClose.join(" and ")} must be more than ${String(m.d)} points from the order price (R5.5b)`,
      );
      continue;
    }
    if ((sl !== null && sl <= 0) || (tp !== null && tp <= 0)) {
      bad.push(`${formatPrice(fromPoints(points(p), spec), spec)}: a level would be at or below zero (R0.4)`);
      continue;
    }
    items.push({
      op: "pending",
      symbol: req.symbol,
      type,
      volume: lots(lotSteps[i] ?? 0, spec.volumeStep),
      openPrice: fromPoints(points(p), spec),
      sl: sl === null ? null : fromPoints(points(sl), spec),
      tp: tp === null ? null : fromPoints(points(tp), spec),
      magic: id.magic,
      comment: `OD:${id.batchShort}`,
      clientId: entryClientId(id, i),
    });
  }
  if (bad.length > 0) {
    return fail({
      code: "PLAN_INVALID",
      message: `${String(bad.length)} of ${String(levels.length)} levels can't be placed: ${bad.join("; ")}.`,
      details: [],
    });
  }
  if (req.slOffsetPoints === undefined) warnings.push(NO_SL_WARNING);
  return {
    ok: true,
    plan: {
      symbol: req.symbol,
      side: req.side,
      type,
      levels: items.length,
      totalLots,
      quote: { bid: fromPoints(m.bid, spec), ask: fromPoints(m.ask, spec), time: quote.time },
      items,
      warnings,
    },
  };
}

const overCount = (n: number, caps: EntryCaps) =>
  invalid(`${String(n)} orders is over your cap of ${String(caps.maxOrdersPerAction)} per action.`);

/** Ladders place plain limit/stop orders only. */
type LadderType = Extract<PendingType, "BUY_LIMIT" | "BUY_STOP" | "SELL_LIMIT" | "SELL_STOP">;

function pendingType(side: Side, kind: "limit" | "stop"): LadderType {
  if (side === "BUY") return kind === "limit" ? "BUY_LIMIT" : "BUY_STOP";
  return kind === "limit" ? "SELL_LIMIT" : "SELL_STOP";
}

/** R5.5: buys trigger off the ask, sells off the bid; at least d away, on the side the type requires. */
function placementProblem(type: LadderType, p: number, m: Market): string | null {
  switch (type) {
    case "BUY_LIMIT":
      return p <= m.ask - m.d ? null : `a buy limit must be at least ${String(m.d)} points below the ask`;
    case "BUY_STOP":
      return p >= m.ask + m.d ? null : `a buy stop must be at least ${String(m.d)} points above the ask`;
    case "SELL_LIMIT":
      return p >= m.bid + m.d ? null : `a sell limit must be at least ${String(m.d)} points above the bid`;
    case "SELL_STOP":
      return p <= m.bid - m.d ? null : `a sell stop must be at least ${String(m.d)} points below the bid`;
  }
}

/** R9.5: lots per level in whole volume steps. Rounds DOWN; every level must be within the symbol's limits. */
function ladderLots(l: LadderRequest["lots"], n: number, spec: SymbolSpec): number[] | string {
  const [start, end] = l.mode === "flat" ? [l.lot, l.lot] : [l.start, l.end];
  if (![start, end].every((v) => Number.isFinite(v) && v > 0)) return "Lot sizes must be positive numbers.";
  // R5.1: the lots the owner TYPED must be on the grid; only the levels in between are derived (and rounded down).
  const s0 = gridSteps(start, spec.volumeStep);
  const s1 = gridSteps(end, spec.volumeStep);
  if (s0 === null) return notOnGrid(start, spec);
  if (s1 === null) return notOnGrid(end, spec);
  const out = Array.from({ length: n }, (_, i) =>
    n === 1 ? s0 : Math.floor(s0 + (i * (s1 - s0)) / (n - 1) + 1e-9),
  );
  for (const steps of out) {
    const problem = lotLimitProblem(lots(steps, spec.volumeStep), spec);
    if (problem !== null) return problem;
  }
  return out;
}

/**
 * §7 for entries: re-check a stored entry against the market at execute time. Empty = still valid.
 * Market orders: SL/TP vs the closing side (R5.3). Pending: placement vs the market (R5.5); its stops are relative to
 * its own price (R5.5b) and can't have changed.
 */
export function entryProblems(item: MarketEntryItem | PendingEntryItem, m: Market): string[] {
  if (item.op === "pending") {
    if (
      item.type !== "BUY_LIMIT" &&
      item.type !== "BUY_STOP" &&
      item.type !== "SELL_LIMIT" &&
      item.type !== "SELL_STOP"
    ) {
      return [`${item.clientId}: unsupported order type ${item.type}`];
    }
    const problem = placementProblem(item.type, toPointsOnGrid(item.openPrice, m), m);
    return problem === null ? [] : [`${formatPrice(item.openPrice, m.spec)}: ${problem}`];
  }
  return (
    [
      ["SL", item.sl],
      ["TP", item.tp],
    ] as const
  ).flatMap(([kind, level]) => {
    if (level === null) return [];
    const v = checkLevel(item.side, kind, toPointsOnGrid(level, m), m);
    return v === null
      ? []
      : [
          `${kind} ${formatPrice(level, m.spec)} must now be ${v.relation} ${formatPrice(fromPoints(v.boundary, m.spec), m.spec)} (${v.rule})`,
        ];
  });
}

const toPointsOnGrid = (p: Price, m: Market): Points => roundToTickPoints(p, m.spec);
