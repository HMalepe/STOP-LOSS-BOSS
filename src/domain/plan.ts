/**
 * Plan builder (M4): request + market snapshot → the exact list of broker calls, or a reason it can't be done.
 * Pure and deterministic: the same input always gives the same plan, in the same order, so "what you preview
 * is exactly what runs" can be checked by hashing.
 */
import { decideCloseAt } from "./closeAt";
import { compareIds, duplicateIds, matchesOrder, matchesPosition } from "./filter";
import { formatPrice, fromPoints, roundToTickPoints, specProblems } from "./price";
import {
  decideModify,
  DEFAULT_BUFFER_POINTS,
  marketFrom,
  quoteProblems,
  ref,
  type LevelChange,
  type LevelKind,
  type Market,
  type ModifyDecision,
} from "./rules";
import type {
  PendingOrder,
  PlanItem,
  Points,
  Position,
  PositionFilter,
  Price,
  Quote,
  Side,
  Skipped,
  SymbolSpec,
} from "./types";

export type PlanRequest =
  | {
      readonly action: "levels";
      readonly filter: PositionFilter;
      readonly stopLoss?: number;
      readonly takeProfit?: number;
    }
  | { readonly action: "closeAt"; readonly filter: PositionFilter; readonly price: number }
  | { readonly action: "close"; readonly filter: PositionFilter; readonly cancelPending: boolean };

export type PlanAction = PlanRequest["action"];

export interface MarketSnapshot {
  readonly positions: readonly Position[];
  readonly orders: readonly PendingOrder[];
  readonly spec: SymbolSpec | null;
  readonly quote: Quote | null;
}

export interface PlanOptions {
  readonly bufferPoints?: number;
}

export interface PlanViolation {
  readonly rule: string;
  readonly side: Side;
  readonly level?: LevelKind;
  readonly boundary?: Price;
  readonly count: number;
  readonly message: string;
}

export type PlanError =
  | { readonly code: "VALIDATION"; readonly message: string }
  | { readonly code: "BROKER_UNAVAILABLE"; readonly message: string; readonly details: readonly string[] }
  | { readonly code: "NO_MATCH"; readonly message: string }
  | { readonly code: "PLAN_INVALID"; readonly message: string; readonly details: readonly PlanViolation[] };

export interface PlanBreakdown {
  readonly buys: number;
  readonly sells: number;
  readonly asSL?: number;
  readonly asTP?: number;
  readonly cancels?: number;
}

export interface PlanDraft {
  readonly action: PlanAction;
  readonly symbol: string;
  readonly quote: { readonly bid: Price; readonly ask: Price; readonly time: number } | null;
  readonly items: readonly PlanItem[];
  readonly skipped: readonly Skipped[];
  readonly breakdown: PlanBreakdown;
  readonly warnings: readonly string[];
}

export type PlanResult =
  { readonly ok: true; readonly plan: PlanDraft } | { readonly ok: false; readonly error: PlanError };

const fail = (error: PlanError): PlanResult => ({ ok: false, error });

const SIDE_WORD: Record<Side, string> = { BUY: "Buy", SELL: "Sell" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** R2.10 (modify plans): no SL first, then biggest loser, then id. */
function byExposure(a: Position, b: Position): number {
  const noSl = Number(a.sl !== null) - Number(b.sl !== null);
  if (noSl !== 0) return noSl;
  return byLoss(a, b);
}

/** R4.6 (close plans): biggest loser first, then id. */
function byLoss(a: Position, b: Position): number {
  if (a.profit !== b.profit) return a.profit - b.profit;
  return compareIds(a.id, b.id);
}

function quoteOut(m: Market, time: number): NonNullable<PlanDraft["quote"]> {
  return { bid: fromPoints(m.bid, m.spec), ask: fromPoints(m.ask, m.spec), time };
}

function validRequest(req: PlanRequest): string | null {
  if (req.filter.symbol.trim() === "") return "Pick a symbol.";
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  switch (req.action) {
    case "levels":
      if (req.stopLoss === undefined && req.takeProfit === undefined) return "Enter an SL, a TP, or both.";
      if (req.stopLoss !== undefined && !positive(req.stopLoss)) return "SL must be a positive price.";
      if (req.takeProfit !== undefined && !positive(req.takeProfit)) return "TP must be a positive price.";
      return null;
    case "closeAt":
      return positive(req.price) ? null : "Enter a valid trigger price.";
    case "close":
      return null;
  }
}

/** R0.1: no trustworthy spec and quote, no plan. */
interface Loaded {
  readonly m: Market;
  readonly time: number;
}

function loadMarket(req: PlanRequest, snap: MarketSnapshot, bufferPoints: number): Loaded | PlanError {
  const symbol = req.filter.symbol;
  if (snap.spec === null) {
    return {
      code: "BROKER_UNAVAILABLE",
      message: `No symbol spec for ${symbol}.`,
      details: ["spec missing"],
    };
  }
  const problems = [
    ...(snap.spec.symbol === symbol ? [] : [`spec is for ${snap.spec.symbol}`]),
    ...specProblems(snap.spec).map((p) => `spec: ${p}`),
    ...(snap.quote === null
      ? ["quote missing"]
      : [
          ...(snap.quote.symbol === symbol ? [] : [`quote is for ${snap.quote.symbol}`]),
          ...quoteProblems(snap.quote).map((p) => `quote: ${p}`),
        ]),
  ];
  if (problems.length > 0 || snap.quote === null) {
    return {
      code: "BROKER_UNAVAILABLE",
      message: `Broker data for ${symbol} isn't usable right now.`,
      details: problems,
    };
  }
  return { m: marketFrom(snap.spec, snap.quote, bufferPoints), time: snap.quote.time };
}

function violationMessage(
  rule: string,
  side: Side,
  level: LevelKind,
  boundary: Price,
  relation: string,
  n: number,
  m: Market,
) {
  return `${SIDE_WORD[side]} ${level} must be ${relation} ${formatPrice(boundary, m.spec)} (${plural(n, "position")}, ${rule}).`;
}

interface Accumulated {
  readonly items: PlanItem[];
  readonly skipped: Skipped[];
  readonly violations: Map<string, PlanViolation>;
}

function skipReason(d: Extract<ModifyDecision, { kind: "skip" }>, m: Market): string {
  if (d.rule === "R2.8") return "unchanged";
  const at = formatPrice(fromPoints(d.frozen.at, m.spec), m.spec);
  return `frozen: ${d.frozen.level} ${at} is within the freeze level (${String(m.freeze)} points)`;
}

function record(acc: Accumulated, pos: Position, d: ModifyDecision, m: Market): void {
  switch (d.kind) {
    case "modify":
      acc.items.push({
        op: "modify",
        positionId: pos.id,
        side: pos.side,
        sl: d.sl === null ? null : fromPoints(d.sl, m.spec),
        tp: d.tp === null ? null : fromPoints(d.tp, m.spec),
      });
      return;
    case "skip":
      acc.skipped.push({ id: pos.id, reason: skipReason(d, m) });
      return;
    case "invalid":
      for (const v of d.violations) {
        const key = `${v.rule}|${v.side}|${v.level}`;
        const prev = acc.violations.get(key);
        const count = (prev?.count ?? 0) + 1;
        const boundary = fromPoints(v.boundary, m.spec);
        acc.violations.set(key, {
          rule: v.rule,
          side: v.side,
          level: v.level,
          boundary,
          count,
          message: violationMessage(v.rule, v.side, v.level, boundary, v.relation, count, m),
        });
      }
      return;
  }
}

function invalid(acc: Accumulated, m: Market): PlanResult {
  const details = [...acc.violations.values()].sort((a, b) =>
    a.rule === b.rule ? a.side.localeCompare(b.side) : a.rule.localeCompare(b.rule),
  );
  const market = `Bid ${formatPrice(fromPoints(m.bid, m.spec), m.spec)} / Ask ${formatPrice(fromPoints(m.ask, m.spec), m.spec)}`;
  return fail({
    code: "PLAN_INVALID",
    message: `${details.map((d) => d.message).join(" ")} ${market}.`,
    details,
  });
}

function sideCounts(items: readonly PlanItem[]): { buys: number; sells: number } {
  const sides = items.flatMap((i) => (i.op === "cancel" ? [] : [i.side]));
  const buys = sides.filter((side) => side === "BUY").length;
  return { buys, sells: sides.length - buys };
}

function buildLevels(
  req: Extract<PlanRequest, { action: "levels" }>,
  positions: readonly Position[],
  m: Market,
  time: number,
): PlanResult {
  const change: LevelChange = {
    ...(req.stopLoss === undefined ? {} : { sl: roundToTickPoints(req.stopLoss, m.spec) }),
    ...(req.takeProfit === undefined ? {} : { tp: roundToTickPoints(req.takeProfit, m.spec) }),
  };
  const acc: Accumulated = { items: [], skipped: [], violations: new Map() };
  for (const pos of [...positions].sort(byExposure)) record(acc, pos, decideModify(pos, change, m), m);
  if (acc.violations.size > 0) return invalid(acc, m);

  const warnings =
    acc.items.length === 0
      ? ["Nothing to change: every matching position already has these levels or is frozen."]
      : [];
  return {
    ok: true,
    plan: {
      action: "levels",
      symbol: req.filter.symbol,
      quote: quoteOut(m, time),
      items: acc.items,
      skipped: acc.skipped,
      breakdown: sideCounts(acc.items),
      warnings,
    },
  };
}

function buildCloseAt(
  req: Extract<PlanRequest, { action: "closeAt" }>,
  positions: readonly Position[],
  m: Market,
  time: number,
): PlanResult {
  const x: Points = roundToTickPoints(req.price, m.spec);
  const xText = formatPrice(fromPoints(x, m.spec), m.spec);
  const acc: Accumulated = { items: [], skipped: [], violations: new Map() };
  const tooClose = new Map<Side, number>();
  let asSL = 0;
  let asTP = 0;

  for (const pos of [...positions].sort(byExposure)) {
    const d = decideCloseAt(pos, x, m);
    if (d.kind === "tooClose") {
      tooClose.set(pos.side, (tooClose.get(pos.side) ?? 0) + 1);
      continue;
    }
    if (d.kind === "modify") {
      if (d.set === "SL") asSL += 1;
      else asTP += 1;
    }
    record(acc, pos, d, m);
  }

  for (const [side, count] of [...tooClose.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const refText = formatPrice(fromPoints(ref(side, m), m.spec), m.spec);
    const priceName = side === "BUY" ? "bid" : "ask";
    acc.violations.set(`R3.1|${side}`, {
      rule: "R3.1",
      side,
      count,
      message: `${xText} is too close to the ${priceName} (${refText}) for ${plural(count, side === "BUY" ? "buy" : "sell")}: it must be more than ${String(m.d)} points away. Use Close All Now instead.`,
    });
  }
  if (acc.violations.size > 0) return invalid(acc, m);

  const counts = sideCounts(acc.items);
  const warnings = [
    "Only covers positions open now. Positions opened later need the trigger set again. (R3.5)",
  ];
  if (counts.buys > 0 && counts.sells > 0) {
    // R3.6, ADR-0004
    warnings.push(
      `Sells close when the ASK reaches ${xText}, buys when the BID reaches it. Spread is ${String(m.ask - m.bid)} points now, so they won't close at the same moment, and a spread spike can trigger one side only. (R3.6)`,
    );
  }
  if (acc.items.length === 0) {
    warnings.push("Nothing to change: every matching position already has this trigger or is frozen.");
  }
  return {
    ok: true,
    plan: {
      action: "closeAt",
      symbol: req.filter.symbol,
      quote: quoteOut(m, time),
      items: acc.items,
      skipped: acc.skipped,
      breakdown: { ...counts, asSL, asTP },
      warnings,
    },
  };
}

function buildClose(
  req: Extract<PlanRequest, { action: "close" }>,
  positions: readonly Position[],
  orders: readonly PendingOrder[],
  snap: MarketSnapshot,
  bufferPoints: number,
): PlanResult {
  const items: PlanItem[] = [...positions]
    .sort(byLoss)
    .map((p) => ({ op: "close", positionId: p.id, side: p.side, volume: p.volume }));
  const cancels: PlanItem[] = [...orders]
    .sort((a, b) => compareIds(a.id, b.id))
    .map((o) => ({ op: "cancel", orderId: o.id }));

  // R4.7: the quote is informational only. A broken spec or quote never blocks close-now.
  const loaded = loadMarket(req, snap, bufferPoints);
  const quote = "code" in loaded ? null : quoteOut(loaded.m, loaded.time);

  return {
    ok: true,
    plan: {
      action: "close",
      symbol: req.filter.symbol,
      quote,
      items: [...items, ...cancels],
      skipped: [],
      breakdown: { ...sideCounts(items), cancels: cancels.length },
      warnings: quote === null ? ["Live price unavailable. Positions still close at market."] : [],
    },
  };
}

export function buildPlan(req: PlanRequest, snap: MarketSnapshot, opts: PlanOptions = {}): PlanResult {
  const bufferPoints = opts.bufferPoints ?? DEFAULT_BUFFER_POINTS;
  const problem = validRequest(req);
  if (problem !== null) return fail({ code: "VALIDATION", message: problem });

  const dupes = [
    ...duplicateIds(snap.positions.map((p) => p.id)).map((id) => `duplicate position ${id}`),
    ...duplicateIds(snap.orders.map((o) => o.id)).map((id) => `duplicate order ${id}`),
  ];
  if (dupes.length > 0) {
    return fail({
      code: "BROKER_UNAVAILABLE",
      message: "Broker sent duplicate tickets. Refresh and try again.",
      details: dupes,
    });
  }

  const positions = snap.positions.filter((p) => matchesPosition(p, req.filter));

  if (req.action === "close") {
    const orders = req.cancelPending ? snap.orders.filter((o) => matchesOrder(o, req.filter)) : [];
    if (positions.length === 0 && orders.length === 0) {
      return fail({ code: "NO_MATCH", message: "Nothing to close." });
    }
    return buildClose(req, positions, orders, snap, bufferPoints);
  }

  const loaded = loadMarket(req, snap, bufferPoints);
  if ("code" in loaded) return fail(loaded);
  if (positions.length === 0) return fail({ code: "NO_MATCH", message: "No matching open positions." });

  switch (req.action) {
    case "levels":
      return buildLevels(req, positions, loaded.m, loaded.time);
    case "closeAt":
      return buildCloseAt(req, positions, loaded.m, loaded.time);
  }
}
