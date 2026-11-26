/**
 * Pending ladders (docs/03 R5.4, R5.5, R5.5b, R5.6, R9.2, R9.5, R9.12). Pure: request + market → the exact pending orders, or the reasons it can't be done.
 * All level maths is in integer ticks (never float prices); duplicates after rounding are removed and REPORTED; a level that can't be valid
 * refuses the whole plan, listing it; scaled lots are rounded down and never bumped up to the minimum.
 */
import { MAX_ITEMS_PER_BATCH } from "./batch";
import { invariant } from "./invariant";
import { ceilCents, riskToSl, type EntryAccount, type EntryCaps } from "./entries";
import { MAX_POINTS_PARAM, type PlanError, type PlanViolation } from "./plan";
import { fromPoints, points, specProblems, tickPoints, toPoints, tryRoundToTickPoints } from "./price";
import { DEFAULT_BUFFER_POINTS, marketFrom, quoteProblems, type Market } from "./rules";
import type { Points, Price, Quote, Side, SymbolSpec } from "./types";
import { checkVolume, lotOfSteps, roundDownToStep, stepsOf } from "./volume";

export type LadderType = "BUY_LIMIT" | "BUY_STOP" | "SELL_LIMIT" | "SELL_STOP";
export type LadderSpacing =
  | { readonly kind: "levels"; readonly levels: number }
  | { readonly kind: "step"; readonly stepPoints: number };
export type LadderLots =
  | { readonly kind: "flat"; readonly volume: number }
  | { readonly kind: "scaled"; readonly start: number; readonly end: number };
/** R9.12: a ladder always states how long it lives. GTC is an explicit, flagged opt-in. */
export type Expiry =
  { readonly type: "DAY" } | { readonly type: "GTC" } | { readonly type: "SPECIFIED"; readonly time: string };

export interface LadderRequest {
  readonly symbol: string;
  readonly type: LadderType;
  readonly from: number;
  readonly to: number;
  readonly spacing: LadderSpacing;
  readonly lots: LadderLots;
  /** R5.6: offsets in points from each level's own price. */
  readonly slPoints?: number;
  readonly tpPoints?: number;
  readonly noStop?: boolean;
  readonly expiry: Expiry;
}

export interface LadderItem {
  readonly op: "pending";
  readonly index: number;
  readonly symbol: string;
  readonly type: LadderType;
  readonly side: Side;
  readonly price: Price;
  readonly volume: number;
  readonly sl: Price | null;
  readonly tp: Price | null;
}

export interface LadderRisk {
  readonly total: number | null;
  readonly largestOrder: number | null;
  readonly unlimited: boolean;
  readonly pctOfEquity: number | null;
}

export interface LadderDraft {
  readonly action: "ladder";
  readonly symbol: string;
  readonly type: LadderType;
  readonly side: Side;
  readonly quote: { readonly bid: Price; readonly ask: Price; readonly time: number };
  readonly items: readonly LadderItem[];
  readonly totalLots: number;
  readonly requestedLevels: number;
  readonly duplicatesRemoved: number;
  readonly risk: LadderRisk;
  readonly expiry: Expiry;
  /** R9.3: ONE margin call at the highest-priced level for the total lots is an upper bound. */
  readonly marginProbe: { readonly type: Side; readonly price: Price; readonly totalLots: number };
  readonly warnings: readonly string[];
}

export type LadderResult =
  { readonly ok: true; readonly plan: LadderDraft } | { readonly ok: false; readonly error: PlanError };

const fail = (error: PlanError): LadderResult => ({ ok: false, error });
const sideOf = (t: LadderType): Side => (t.startsWith("BUY") ? "BUY" : "SELL");

/** Round half away from zero on a rational n/d (d > 0), exactly, in integers. */
function roundDiv(n: number, d: number): number {
  const q = Math.floor((2 * Math.abs(n) + d) / (2 * d));
  return n < 0 ? -q : q;
}

export type LevelsResult =
  | { readonly ok: true; readonly levels: readonly Points[]; readonly requested: number }
  | { readonly ok: false; readonly message: string };

/** R5.4 level count BEFORE generating anything, so a huge request can't allocate. */
export function plannedLevels(
  a: Points,
  b: Points,
  spacing: LadderSpacing,
  spec: Pick<SymbolSpec, "point" | "digits" | "tickSize">,
): number | string {
  const t = tickPoints(spec);
  if (spacing.kind === "levels") {
    return Number.isSafeInteger(spacing.levels) && spacing.levels >= 1
      ? spacing.levels
      : "How many levels? Enter a whole number, 1 or more.";
  }
  if (!(
    Number.isSafeInteger(spacing.stepPoints) &&
    spacing.stepPoints >= 1 &&
    spacing.stepPoints <= MAX_POINTS_PARAM
  )) {
    return `The step must be a whole number of points, 1 to ${String(MAX_POINTS_PARAM)}.`;
  }
  if (spacing.stepPoints % t !== 0) return `The step must be a multiple of the tick (${String(t)} points).`;
  return Math.floor(Math.abs(b - a) / spacing.stepPoints) + 1;
}

/**
 * R5.4. Levels mode: price_i = A + i(B−A)/(N−1) rounded to the tick (N = 1 → A), duplicates removed in order.
 * Step mode: every K points from A toward B; B only if it lands exactly on a step.
 */
export function ladderLevels(
  a: Points,
  b: Points,
  spacing: LadderSpacing,
  spec: Pick<SymbolSpec, "point" | "digits" | "tickSize">,
): LevelsResult {
  const planned = plannedLevels(a, b, spacing, spec);
  if (typeof planned === "string") return { ok: false, message: planned };
  const t = tickPoints(spec);
  const aT = a / t;
  const bT = b / t;
  const out: Points[] = [];
  const push = (ticks: number) => {
    const p = points(ticks * t);
    if (out.at(-1) !== p) out.push(p);
  };
  if (spacing.kind === "step") {
    const dir = bT >= aT ? 1 : -1;
    const k = spacing.stepPoints / t;
    for (let i = 0; i < planned; i++) push(aT + dir * k * i);
  } else if (planned === 1) {
    push(aT);
  } else {
    for (let i = 0; i < planned; i++) push(aT + roundDiv(i * (bT - aT), planned - 1));
  }
  return { ok: true, levels: out, requested: planned };
}

/** R5.5: is this level on the right side of the market for its type, at least d away? Strict, like §2. */
function levelProblem(
  type: LadderType,
  p: Points,
  m: Market,
): { boundary: Points; relation: "below" | "above" } | null {
  switch (type) {
    case "BUY_LIMIT":
      return p < m.ask - m.d ? null : { boundary: points(m.ask - m.d), relation: "below" };
    case "BUY_STOP":
      return p > m.ask + m.d ? null : { boundary: points(m.ask + m.d), relation: "above" };
    case "SELL_LIMIT":
      return p > m.bid + m.d ? null : { boundary: points(m.bid + m.d), relation: "above" };
    case "SELL_STOP":
      return p < m.bid - m.d ? null : { boundary: points(m.bid - m.d), relation: "below" };
  }
}

const TYPE_WORD: Record<LadderType, string> = {
  BUY_LIMIT: "Buy Limit",
  BUY_STOP: "Buy Stop",
  SELL_LIMIT: "Sell Limit",
  SELL_STOP: "Sell Stop",
};

export function buildLadder(
  req: LadderRequest,
  snap: { readonly spec: SymbolSpec | null; readonly quote: Quote | null },
  caps: EntryCaps,
  account: EntryAccount,
  opts: { readonly bufferPoints?: number } = {},
): LadderResult {
  const side = sideOf(req.type);
  if (req.symbol.trim() === "") return fail({ code: "VALIDATION", message: "Pick a symbol." });
  if (!account.hedging) {
    return fail({
      code: "VALIDATION",
      message:
        "This account is netting: many orders would merge into one position. Ladders need a hedging account.",
    });
  }
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
  if (req.expiry.type === "SPECIFIED" && !Number.isFinite(Date.parse(req.expiry.time))) {
    return fail({ code: "VALIDATION", message: "That expiry time isn't a valid date." });
  }
  for (const [name, v] of [
    ["SL", req.slPoints],
    ["TP", req.tpPoints],
  ] as const) {
    if (v !== undefined && !(Number.isSafeInteger(v) && v >= 1 && v <= MAX_POINTS_PARAM)) {
      return fail({
        code: "VALIDATION",
        message: `${name} must be a whole number of points, 1 to ${String(MAX_POINTS_PARAM)}.`,
      });
    }
  }

  const a = tryRoundToTickPoints(req.from, spec);
  const b = tryRoundToTickPoints(req.to, spec);
  if (a === null || b === null || a <= 0 || b <= 0) {
    return fail({ code: "VALIDATION", message: `Those prices are out of range for ${spec.symbol}.` });
  }

  // R5.2: count checked from the PLAN, before anything is generated.
  const planned = plannedLevels(a, b, req.spacing, spec);
  if (typeof planned === "string") return fail({ code: "VALIDATION", message: planned });
  if (planned > Math.min(caps.maxOrders, MAX_ITEMS_PER_BATCH)) {
    return fail({
      code: "PLAN_INVALID",
      message: "Over the safety limits for one action.",
      details: [
        {
          rule: "R5.2",
          side,
          count: planned,
          message: `${String(planned)} orders is over the limit of ${String(caps.maxOrders)} per action.`,
        },
      ],
    });
  }
  const gen = ladderLevels(a, b, req.spacing, spec);
  if (!gen.ok) return fail({ code: "VALIDATION", message: gen.message });
  const levels = gen.levels;
  const duplicatesRemoved = gen.requested - levels.length;
  const n = levels.length;

  // R9.5 / R5.1 lots, per level.
  const lots: number[] = [];
  const stepsPer: number[] = [];
  if (req.lots.kind === "flat") {
    const v = checkVolume(req.lots.volume, spec);
    if (!v.ok) return fail({ code: "VALIDATION", message: v.message });
    for (let i = 0; i < n; i++) {
      lots.push(v.volume);
      stepsPer.push(v.steps);
    }
  } else {
    for (const [name, x] of [
      ["first", req.lots.start],
      ["last", req.lots.end],
    ] as const) {
      const v = checkVolume(x, spec);
      if (!v.ok) return fail({ code: "VALIDATION", message: `The ${name} lot: ${v.message}` });
    }
    const { start, end } = req.lots;
    for (let i = 0; i < n; i++) {
      const raw = n === 1 ? start : start + (i * (end - start)) / (n - 1);
      const lot = roundDownToStep(raw, spec.volumeStep);
      // Both ends are validated (on the grid, within min/max) and every level lies between them, so rounding DOWN to a grid
      // point can't leave [min, max]. If this ever fires the maths above is broken: stop, never bump a lot.
      invariant(
        lot >= spec.volumeMin - 1e-9 && lot <= spec.volumeMax + 1e-9,
        `R9.5 level ${String(i + 1)} lot ${String(lot)} left [min, max]`,
      );
      lots.push(lot);
      stepsPer.push(stepsOf(lot, spec.volumeStep) ?? 0);
    }
  }
  const totalSteps = stepsPer.reduce((x, y) => x + y, 0);
  const totalLots = lotOfSteps(totalSteps, spec.volumeStep);
  if (totalLots > caps.maxTotalLots + 1e-9) {
    return fail({
      code: "PLAN_INVALID",
      message: "Over the safety limits for one action.",
      details: [
        {
          rule: "R5.2",
          side,
          count: n,
          message: `${String(totalLots)} lots in total is over the limit of ${String(caps.maxTotalLots)} per action.`,
        },
      ],
    });
  }

  // R5.5: every level must be valid for its type, or the plan is refused, listing them.
  const m = marketFrom(spec, quote, opts.bufferPoints ?? DEFAULT_BUFFER_POINTS);
  const wrong = levels.filter((p) => levelProblem(req.type, p, m) !== null);
  if (wrong.length > 0) {
    const first = levelProblem(req.type, wrong[0] ?? levels[0] ?? a, m);
    const list = wrong
      .slice(0, 5)
      .map((p) => fromPoints(p, spec).toFixed(spec.digits))
      .join(", ");
    const violation: PlanViolation = {
      rule: "R5.5",
      side,
      boundary: fromPoints(first?.boundary ?? a, spec),
      count: wrong.length,
      message: `${TYPE_WORD[req.type]} levels must be ${first?.relation ?? "beyond"} ${fromPoints(first?.boundary ?? a, spec).toFixed(spec.digits)} (the ${side === "BUY" ? "ask" : "bid"} ${req.type.endsWith("LIMIT") === (side === "BUY") ? "minus" : "plus"} ${String(m.d)} points). ${String(wrong.length)} of ${String(n)} aren't: ${list}${wrong.length > 5 ? "…" : ""}.`,
    };
    return fail({
      code: "PLAN_INVALID",
      message: `Some levels can't be a ${TYPE_WORD[req.type]} right now. Nothing was built.`,
      details: [violation],
    });
  }

  // R5.5b: SL/TP on a pending are checked against the pending's OWN price, not the market.
  const slOff = req.slPoints;
  const tpOff = req.tpPoints;
  const buy = side === "BUY";
  const slOf = (p: Points) => (slOff === undefined ? null : points(buy ? p - slOff : p + slOff));
  const tpOf = (p: Points) => (tpOff === undefined ? null : points(buy ? p + tpOff : p - tpOff));
  const stopViolations: PlanViolation[] = [];
  if (slOff !== undefined && slOff <= m.d) {
    stopViolations.push({
      rule: "R5.5b",
      side,
      level: "SL",
      count: n,
      message: `A stop on a pending order must be more than ${String(m.d)} points from the order's own price. ${String(slOff)} is too close.`,
    });
  }
  if (tpOff !== undefined && tpOff <= m.d) {
    stopViolations.push({
      rule: "R5.5b",
      side,
      level: "TP",
      count: n,
      message: `A take profit on a pending order must be more than ${String(m.d)} points from the order's own price. ${String(tpOff)} is too close.`,
    });
  }
  for (const p of levels) {
    for (const [kind, lvl] of [
      ["SL", slOf(p)],
      ["TP", tpOf(p)],
    ] as const) {
      if (lvl !== null && lvl <= 0 && !stopViolations.some((v) => v.rule === "R0.4" && v.level === kind)) {
        stopViolations.push({
          rule: "R0.4",
          side,
          level: kind,
          count: n,
          message: `${kind} would be at or below zero for a level at ${fromPoints(p, spec).toFixed(spec.digits)}.`,
        });
      }
    }
  }
  if (stopViolations.length > 0) {
    return fail({
      code: "PLAN_INVALID",
      message: "The stop or take profit isn't valid for these orders. Nothing was built.",
      details: stopViolations,
    });
  }

  // R9.2b: a stop unless the owner explicitly chose none.
  if (slOff === undefined && req.noStop !== true) {
    return fail({
      code: "VALIDATION",
      message: 'Add a stop loss, or choose "no stop" to place orders without one.',
    });
  }

  // R9.2 risk, per level at the order's own price.
  const warnings: string[] = [];
  let risk: LadderRisk = { total: null, largestOrder: null, unlimited: true, pctOfEquity: null };
  if (slOff !== undefined) {
    let total = 0;
    let largest = 0;
    for (let i = 0; i < n; i++) {
      const p = levels[i] ?? a;
      const r = riskToSl({
        entry: p,
        sl: slOf(p) ?? p,
        spec,
        lots: lots[i] ?? 0,
        lossTickValue: quote.lossTickValue,
        commissionPerLot: account.commissionPerLot,
      });
      if (r === null) {
        return fail({
          code: "BROKER_UNAVAILABLE",
          message: "Can't verify the money at risk (no tick value from the broker). Nothing was built.",
          details: ["lossTickValue missing"],
        });
      }
      total += r;
      largest = Math.max(largest, r);
    }
    if (!(Number.isFinite(account.equity) && account.equity > 0)) {
      return fail({
        code: "BROKER_UNAVAILABLE",
        message: "Can't verify the account equity. Nothing was built.",
        details: ["equity"],
      });
    }
    total = ceilCents(total);
    const pct = (total / account.equity) * 100;
    if (pct > caps.maxRiskPct) {
      return fail({
        code: "PLAN_INVALID",
        message: "That's more risk than one action is allowed to take.",
        details: [
          {
            rule: "R9.2a",
            side,
            count: n,
            message: `Risk to the stops is ${total.toFixed(2)} (${pct.toFixed(2)}% of equity). The limit is ${String(caps.maxRiskPct)}% per action.`,
          },
        ],
      });
    }
    risk = { total, largestOrder: largest, unlimited: false, pctOfEquity: pct };
    warnings.push(
      "Risk assumes every level fills at its own price. It excludes gaps and slippage, and uses today's currency rates.",
    );
  } else {
    warnings.push("No stop loss: the risk on these orders is not limited.");
  }
  if (duplicatesRemoved > 0) {
    warnings.push(
      `${String(duplicatesRemoved)} level${duplicatesRemoved === 1 ? "" : "s"} landed on the same price after rounding, so ${String(n)} orders instead of ${String(gen.requested)}.`,
    );
  }
  if (req.expiry.type === "GTC") {
    warnings.push(
      "Good-till-cancelled: these orders stay until you cancel them, even overnight and through news.",
    );
  }

  const items: LadderItem[] = levels.map((p, index) => ({
    op: "pending",
    index,
    symbol: spec.symbol,
    type: req.type,
    side,
    price: fromPoints(p, spec),
    volume: lots[index] ?? 0,
    sl: ((s) => (s === null ? null : fromPoints(s, spec)))(slOf(p)),
    tp: ((t) => (t === null ? null : fromPoints(t, spec)))(tpOf(p)),
  }));
  const highest = levels.reduce((x, y) => (y > x ? y : x), levels[0] ?? a);
  return {
    ok: true,
    plan: {
      action: "ladder",
      symbol: spec.symbol,
      type: req.type,
      side,
      quote: {
        bid: fromPoints(toPoints(quote.bid, spec), spec),
        ask: fromPoints(toPoints(quote.ask, spec), spec),
        time: quote.time,
      },
      items,
      totalLots,
      requestedLevels: gen.requested,
      duplicatesRemoved,
      risk,
      expiry: req.expiry,
      marginProbe: { type: side, price: fromPoints(highest, spec), totalLots },
      warnings,
    },
  };
}
