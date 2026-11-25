/**
 * Bulk market entries (docs/03 §5, §9). Pure: request + market snapshot + caps + account → the exact entries, with the
 * risk they carry, or the reasons it can't be done. Never builds an entry without a stop the owner asked for (R5.3),
 * and never builds a stop-less batch unless the owner explicitly chose "no stop" (R9.2b).
 */
import { invariant } from "./invariant";
import { MAX_ITEMS_PER_BATCH } from "./batch";
import { MAX_POINTS_PARAM, type PlanError, type PlanViolation } from "./plan";
import { fromPoints, points, specProblems, tickPoints, toPoints, tryRoundToTickPoints } from "./price";
import {
  checkLevel,
  DEFAULT_BUFFER_POINTS,
  marketFrom,
  quoteProblems,
  type LevelKind,
  type LevelViolation,
} from "./rules";
import type { Points, Price, Quote, Side, SymbolSpec } from "./types";
import { checkVolume, lotOfSteps } from "./volume";

/** A level the owner asks for: points from the expected fill, or an absolute price. */
export type LevelSpec =
  { readonly mode: "points"; readonly points: number } | { readonly mode: "price"; readonly price: number };

export interface MarketBatchRequest {
  readonly symbol: string;
  readonly side: Side;
  readonly count: number;
  readonly volume: number;
  readonly sl?: LevelSpec;
  readonly tp?: LevelSpec;
  /** R9.2b: explicit opt-in to a batch with no stop. Ignored when an SL is given. */
  readonly noStop?: boolean;
}

export interface EntryCaps {
  readonly maxOrders: number;
  readonly maxTotalLots: number;
  readonly maxRiskPct: number;
}

export interface EntryAccount {
  readonly equity: number;
  /** R0.2: batch entries need a hedging account (netting merges N entries into one position). */
  readonly hedging: boolean;
  /** R9.2: per-lot commission (not on the spec or price feed; configured). */
  readonly commissionPerLot: number;
}

export interface EntryItem {
  readonly op: "market";
  readonly index: number;
  readonly symbol: string;
  readonly side: Side;
  readonly volume: number;
  readonly sl: Price | null;
  readonly tp: Price | null;
}

export interface EntryRisk {
  readonly perOrder: number | null;
  readonly total: number | null;
  /** No stop (R9.2b): risk is not limited. */
  readonly unlimited: boolean;
  readonly pctOfEquity: number | null;
}

export interface EntryDraft {
  readonly action: "market";
  readonly symbol: string;
  readonly side: Side;
  readonly quote: { readonly bid: Price; readonly ask: Price; readonly time: number };
  readonly items: readonly EntryItem[];
  readonly totalLots: number;
  readonly risk: EntryRisk;
  readonly warnings: readonly string[];
}

export type EntryResult =
  { readonly ok: true; readonly plan: EntryDraft } | { readonly ok: false; readonly error: PlanError };

const fail = (error: PlanError): EntryResult => ({ ok: false, error });
const invalid = (v: PlanViolation[], message: string): EntryResult =>
  fail({ code: "PLAN_INVALID", message, details: v });

/** Money in cents, rounded UP (round-then-sum can understate risk), immune to float dust. */
export function ceilCents(x: number): number {
  return Math.ceil(Math.round(x * 1e6) / 1e4) / 100;
}

/** R9.2: risk to the SL for one order, in account currency. null if lossTickValue can't be trusted. */
export function riskToSl(args: {
  readonly entry: Points;
  readonly sl: Points;
  readonly spec: SymbolSpec;
  readonly lots: number;
  readonly lossTickValue: number | undefined;
  readonly commissionPerLot: number;
}): number | null {
  const { lossTickValue } = args;
  if (lossTickValue === undefined || !(Number.isFinite(lossTickValue) && lossTickValue > 0)) return null;
  const ticks = Math.round(Math.abs(args.entry - args.sl) / tickPoints(args.spec));
  return ceilCents(ticks * lossTickValue * args.lots + args.commissionPerLot * args.lots);
}

/** R5.3: the level as a price. Points are measured from the EXPECTED FILL (buy: ask, sell: bid); price mode is rounded to the tick. */
function levelPrice(
  side: Side,
  kind: LevelKind,
  spec: LevelSpec,
  fill: Points,
  m: SymbolSpec,
): Points | null {
  if (spec.mode === "price") return tryRoundToTickPoints(spec.price, m);
  const up = (side === "BUY") === (kind === "TP"); // buy TP and sell SL sit above the fill
  return points(up ? fill + spec.points : fill - spec.points);
}

const sideWord = (s: Side) => (s === "BUY" ? "buy" : "sell");

export function buildMarketBatch(
  req: MarketBatchRequest,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
  caps: EntryCaps,
  account: EntryAccount,
  opts: { readonly bufferPoints?: number } = {},
): EntryResult {
  // Request shape.
  if (req.symbol.trim() === "") return fail({ code: "VALIDATION", message: "Pick a symbol." });
  if (!Number.isSafeInteger(req.count) || req.count < 1) {
    return fail({ code: "VALIDATION", message: "How many orders? Enter a whole number, 1 or more." });
  }
  invariant(
    caps.maxOrders <= MAX_ITEMS_PER_BATCH,
    "MAX_ORDERS_PER_ACTION must be ≤ 1000 (clientId carries a 3-digit index)",
  );
  for (const [name, l] of [
    ["SL", req.sl],
    ["TP", req.tp],
  ] as const) {
    if (l === undefined) continue;
    const bad =
      l.mode === "points"
        ? !(Number.isSafeInteger(l.points) && l.points >= 1 && l.points <= MAX_POINTS_PARAM)
        : !(Number.isFinite(l.price) && l.price > 0);
    if (bad) {
      return fail({
        code: "VALIDATION",
        message:
          l.mode === "points"
            ? `${name} must be a whole number of points, 1 to ${String(MAX_POINTS_PARAM)}.`
            : `${name} must be a positive price.`,
      });
    }
  }
  // R0.2
  if (!account.hedging) {
    return fail({
      code: "VALIDATION",
      message:
        "This account is netting: many orders would merge into one position. Batch entries need a hedging account.",
    });
  }
  // R0.1
  const { spec, quote } = snap;
  if (spec === null || quote === null) {
    return fail({
      code: "BROKER_UNAVAILABLE",
      message: "No spec or price for this symbol. Refresh and try again.",
      details: ["missing spec or quote"],
    });
  }
  const bad = [...specProblems(spec), ...quoteProblems(quote)];
  if (bad.length > 0) {
    return fail({
      code: "BROKER_UNAVAILABLE",
      message: "Broker data for this symbol can't be trusted. Refresh and try again.",
      details: bad,
    });
  }

  // R5.1 volume on the grid.
  const vol = checkVolume(req.volume, spec);
  if (!vol.ok) return fail({ code: "VALIDATION", message: vol.message });
  // R5.2 caps.
  const totalLots = lotOfSteps(vol.steps * req.count, spec.volumeStep);
  const caps_: PlanViolation[] = [];
  if (req.count > caps.maxOrders) {
    caps_.push({
      rule: "R5.2",
      side: req.side,
      count: req.count,
      message: `${String(req.count)} orders is over the limit of ${String(caps.maxOrders)} per action.`,
    });
  }
  if (totalLots > caps.maxTotalLots + 1e-9) {
    caps_.push({
      rule: "R5.2",
      side: req.side,
      count: req.count,
      message: `${String(totalLots)} lots in total is over the limit of ${String(caps.maxTotalLots)} per action.`,
    });
  }
  if (caps_.length > 0) return invalid(caps_, "Over the safety limits for one action.");

  // R5.3 levels, validated with §2 against the CLOSING price of the side.
  const m = marketFrom(spec, quote, opts.bufferPoints ?? DEFAULT_BUFFER_POINTS);
  const fill = req.side === "BUY" ? m.ask : m.bid;
  const levels: Partial<Record<LevelKind, Points>> = {};
  for (const [kind, l] of [
    ["SL", req.sl],
    ["TP", req.tp],
  ] as const) {
    if (l === undefined) continue;
    const p = levelPrice(req.side, kind, l, fill, spec);
    if (p === null) {
      return fail({
        code: "VALIDATION",
        message: `That ${kind} price is out of range for ${spec.symbol}. (R0.6)`,
      });
    }
    levels[kind] = p;
  }
  const violations: LevelViolation[] = [];
  for (const kind of ["SL", "TP"] as const) {
    const p = levels[kind];
    const v = p === undefined ? null : checkLevel(req.side, kind, p, m);
    if (v !== null) violations.push(v);
  }
  if (violations.length > 0) {
    return invalid(
      violations.map((v) => ({
        rule: v.rule,
        side: v.side,
        level: v.level,
        boundary: fromPoints(v.boundary, spec),
        count: req.count,
        message: `${v.level} for a ${sideWord(v.side)} must be ${v.relation} ${fromPoints(v.boundary, spec).toFixed(spec.digits)} (${v.rule}). It would be placed from the ${req.side === "BUY" ? "ask" : "bid"}, but checked against the ${v.side === "BUY" ? "bid" : "ask"}.`,
      })),
      `The ${req.sl === undefined ? "TP" : "stop"} isn't valid for ${String(req.count)} ${sideWord(req.side)} orders. Nothing was built.`,
    );
  }

  // R9.2b: a stop is required unless the owner explicitly chose none.
  const noStop = req.sl === undefined;
  if (noStop && req.noStop !== true) {
    return fail({ code: "VALIDATION", message: 'Add a stop loss, or choose "no stop" to open without one.' });
  }

  // R9.2 risk.
  let risk: EntryRisk = { perOrder: null, total: null, unlimited: true, pctOfEquity: null };
  const warnings: string[] = [];
  const slPts = levels.SL;
  if (slPts !== undefined) {
    const perOrder = riskToSl({
      entry: fill,
      sl: slPts,
      spec,
      lots: vol.volume,
      lossTickValue: quote.lossTickValue,
      commissionPerLot: account.commissionPerLot,
    });
    if (perOrder === null) {
      return fail({
        code: "BROKER_UNAVAILABLE",
        message: "Can't verify the money at risk (no tick value from the broker). Nothing was built.",
        details: ["lossTickValue missing"],
      });
    }
    if (!(Number.isFinite(account.equity) && account.equity > 0)) {
      return fail({
        code: "BROKER_UNAVAILABLE",
        message: "Can't verify the account equity. Nothing was built.",
        details: ["equity"],
      });
    }
    const total = ceilCents(perOrder * req.count);
    const pct = (total / account.equity) * 100;
    if (pct > caps.maxRiskPct) {
      return invalid(
        [
          {
            rule: "R9.2a",
            side: req.side,
            count: req.count,
            message: `Risk to the stop is ${total.toFixed(2)} (${pct.toFixed(2)}% of equity). The limit is ${String(caps.maxRiskPct)}% per action.`,
          },
        ],
        "That's more risk than one action is allowed to take.",
      );
    }
    risk = { perOrder, total, unlimited: false, pctOfEquity: pct };
    warnings.push("Risk excludes gaps and slippage, and uses today's currency rates.");
  } else {
    warnings.push("No stop loss: the risk on these orders is not limited.");
  }

  const toPrice = (p: Points | undefined): Price | null => (p === undefined ? null : fromPoints(p, spec));
  const sl = toPrice(levels.SL);
  const tp = toPrice(levels.TP);
  // R5.3 / non-negotiable 9, asserted: a requested stop is on every entry.
  invariant(req.sl === undefined || sl !== null, "a requested SL must be on every entry");
  const items: EntryItem[] = Array.from({ length: req.count }, (_, index) => ({
    op: "market",
    index,
    symbol: spec.symbol,
    side: req.side,
    volume: vol.volume,
    sl,
    tp,
  }));
  return {
    ok: true,
    plan: {
      action: "market",
      symbol: spec.symbol,
      side: req.side,
      quote: {
        bid: fromPoints(toPoints(quote.bid, spec), spec),
        ask: fromPoints(toPoints(quote.ask, spec), spec),
        time: quote.time,
      },
      items,
      totalLots,
      risk,
      warnings,
    },
  };
}
