/**
 * R9.3 margin. The broker's calculateMargin is STANDALONE (ignores existing positions, but also tiered leverage), so the caller asks it for
 * existing+new and existing-only; we take the difference plus a 10% safety factor. Unverifiable = blocked. Never an estimate.
 */
export const MARGIN_SAFETY_FACTOR = 1.1;
export const MARGIN_WARN_LEVEL_PCT = 300;
export const NO_STOP_FLOOR_PCT = 500;

/** Margin the new orders need. undefined = the broker couldn't compute it (blocks). */
export function netMargin(withNew: number | undefined, existingOnly: number | undefined): number | undefined {
  if (withNew === undefined || existingOnly === undefined) return undefined;
  if (!(Number.isFinite(withNew) && Number.isFinite(existingOnly) && withNew > 0 && existingOnly >= 0)) {
    return undefined;
  }
  return Math.max(0, withNew - existingOnly) * MARGIN_SAFETY_FACTOR;
}

export type MarginVerdict =
  | { readonly ok: true; readonly warnings: readonly string[]; readonly required: number }
  | {
      readonly ok: false;
      readonly code: "MARGIN_UNVERIFIED" | "MARGIN_INSUFFICIENT";
      readonly message: string;
    };

export function marginVerdict(a: {
  readonly required: number | undefined;
  readonly freeMargin: number;
  readonly equity: number;
  /** Margin currently in use. */
  readonly usedMargin: number;
  /** R9.2 total risk; null = no stop (unlimited). */
  readonly totalRisk: number | null;
  /** The broker's stop-out margin level in %, if known. */
  readonly stopOutPct: number | null;
}): MarginVerdict {
  if (a.required === undefined) {
    return {
      ok: false,
      code: "MARGIN_UNVERIFIED",
      message: "Can't verify the margin for this batch, so it's blocked.",
    };
  }
  if (a.required > a.freeMargin) {
    return {
      ok: false,
      code: "MARGIN_INSUFFICIENT",
      message: `This batch needs ${a.required.toFixed(2)} margin; you have ${a.freeMargin.toFixed(2)} free.`,
    };
  }
  const after = a.usedMargin + a.required;
  const level = after === 0 ? Infinity : (a.equity / after) * 100;
  if (a.totalRisk === null && level < NO_STOP_FLOOR_PCT) {
    return {
      ok: false,
      code: "MARGIN_INSUFFICIENT",
      message: `With no stop the margin level must stay above ${String(NO_STOP_FLOOR_PCT)}%. This would leave ${level.toFixed(0)}%.`,
    };
  }
  const warnings: string[] = [];
  if (level < MARGIN_WARN_LEVEL_PCT) warnings.push(`Margin level would drop to ${level.toFixed(0)}%.`);
  if (a.totalRisk !== null && a.stopOutPct !== null && after > 0) {
    const worst = ((a.equity - a.totalRisk) / after) * 100;
    if (worst < a.stopOutPct) {
      warnings.push(
        `If every stop is hit, the margin level would fall to ${worst.toFixed(0)}%, below the broker's stop-out (${String(a.stopOutPct)}%).`,
      );
    }
  }
  return { ok: true, warnings, required: a.required };
}
