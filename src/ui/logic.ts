/**
 * Pure display logic for the trading controls. No DOM, no React: unit-tested. The UI never decides whether a trade is
 * valid (CLAUDE.md); this only formats, nudges and counts down. Prices move in integer points, never raw float math.
 */

/** Parse a typed price. null if it isn't a positive finite number. Accepts "1,08611" from European keyboards. */
export function parsePrice(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** price ± `points` (1 point = 10^-digits), done in integer points so 1.1 + 0.2 never misbehaves. */
export function nudge(text: string, points: number, digits: number): string {
  const p = parsePrice(text);
  if (p === null) return text;
  const scale = 10 ** digits;
  const next = Math.round(p * scale) + points;
  return next <= 0 ? text : (next / scale).toFixed(digits);
}

/** "1,234.50" money with an explicit sign and a real minus. */
export function signedMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? `+${abs}` : n < 0 ? `−${abs}` : abs;
}

/** Spread in points between bid and ask. */
export function spreadPoints(bid: number, ask: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(ask * scale) - Math.round(bid * scale);
}

/** Countdown to a plan's expiry: whole seconds left (ceil) and the fraction remaining 0..1 for the ring. */
export function countdown(
  expiresAtIso: string,
  now: number,
  ttlMs = 30_000,
): { seconds: number; fraction: number; expired: boolean } {
  const left = Date.parse(expiresAtIso) - now;
  if (!Number.isFinite(left) || left <= 0) return { seconds: 0, fraction: 0, expired: true };
  return { seconds: Math.ceil(left / 1000), fraction: Math.min(1, left / ttlMs), expired: false };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface SummaryLike {
  readonly action: "levels" | "closeAt" | "close" | "breakeven" | "lock";
  readonly symbol: string;
  readonly count: number;
  readonly breakdown: {
    readonly buys: number;
    readonly sells: number;
    readonly asSL?: number;
    readonly asTP?: number;
    readonly cancels?: number;
  };
}

export type Ask =
  | { readonly action: "levels"; readonly stopLoss?: string; readonly takeProfit?: string }
  | { readonly action: "closeAt"; readonly price: string }
  | { readonly action: "breakeven"; readonly offsetPoints: number }
  | { readonly action: "lock"; readonly distancePoints: number }
  | { readonly action: "close" };

/** The confirm sheet's plain sentence (07-UI-SPEC #7): what will happen, in words, with the numbers that matter. */
export function planSentence(s: SummaryLike, ask: Ask): string {
  const n = plural(s.count, `${s.symbol} position`);
  switch (ask.action) {
    case "closeAt": {
      const parts = [
        (s.breakdown.asTP ?? 0) > 0 ? `${String(s.breakdown.asTP)} as take profit` : null,
        (s.breakdown.asSL ?? 0) > 0 ? `${String(s.breakdown.asSL)} as stop loss` : null,
      ].filter((x): x is string => x !== null);
      return `${n} will close at ${ask.price}.${parts.length > 0 ? ` ${parts.join(", ")}.` : ""}`;
    }
    case "levels": {
      const what = [
        ask.stopLoss === undefined ? null : `SL ${ask.stopLoss}`,
        ask.takeProfit === undefined ? null : `TP ${ask.takeProfit}`,
      ].filter((x): x is string => x !== null);
      const keep =
        ask.stopLoss === undefined
          ? " Existing SLs stay."
          : ask.takeProfit === undefined
            ? " Existing TPs stay."
            : "";
      return `${n} get ${what.join(" and ")}.${keep}`;
    }
    case "breakeven":
      return `${n} move their SL to entry${ask.offsetPoints > 0 ? ` +${String(ask.offsetPoints)} points` : ""}.`;
    case "lock":
      return `${n} lock profit with an SL ${String(ask.distancePoints)} points behind price.`;
    case "close": {
      const cancels = s.breakdown.cancels ?? 0;
      return `${n} close now at market${cancels > 0 ? `, and ${plural(cancels, "pending order")} cancel` : ""}.`;
    }
  }
}

export interface ProgressLike {
  readonly total: number;
  readonly done: number;
  readonly ok: number;
  readonly failed: number;
  readonly unknown: number;
  readonly skipped: number;
}

/** Non-negotiable 6 in words: never "done" when something failed or is unknown. */
export function progressHeadline(
  p: ProgressLike,
  finished: boolean,
): { text: string; tone: "up" | "down" | "warn" | "neutral" } {
  if (!finished) return { text: `Sending ${String(p.done)} of ${String(p.total)}`, tone: "neutral" };
  if (p.total === 0) return { text: "Nothing was sent", tone: "neutral" };
  if (p.ok === p.total) return { text: `All ${String(p.total)} done`, tone: "up" };
  const bits = [
    `${String(p.ok)} of ${String(p.total)} done`,
    p.failed > 0 ? `${String(p.failed)} failed` : null,
    p.unknown > 0 ? `${String(p.unknown)} unknown, check MT5` : null,
    p.skipped > 0 ? `${String(p.skipped)} not sent` : null,
  ].filter((x): x is string => x !== null);
  return { text: bits.join(" · "), tone: p.unknown > 0 ? "warn" : p.failed > 0 ? "down" : "warn" };
}
