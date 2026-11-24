/**
 * R9.4 spread guard: checked at EXECUTE time, either check refuses the whole batch with zero broker calls.
 * - R9.4a absolute: spread > maxPts (per symbol, optional, off by default).
 * - R9.4b adaptive: spread > k × MEDIAN spread of recent ticks. The median ignores the spike that is usually the very
 *   reason to refuse (news); a mean would drift up and let it through. Needs MIN_SAMPLES ticks; below that fall back to
 *   R9.4a, and if that's off too, warn and don't block.
 * Pure. All values in points.
 */
export const MIN_SAMPLES = 30;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export interface SpreadInput {
  readonly spreadPts: number;
  readonly samples: readonly number[];
  readonly k: number;
  readonly maxPts?: number | undefined;
}

export interface SpreadVerdict {
  readonly block: boolean;
  readonly spreadPts: number;
  /** Median of the window, when there were enough ticks. */
  readonly normalPts: number | null;
  /** Why it blocks. */
  readonly reason?: string;
  /** For the preview: "Spread now X pts, normal Y pts." */
  readonly summary: string;
  /** Not enough data to judge and no absolute max: shown, never blocks. */
  readonly warning?: string;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function spreadVerdict(i: SpreadInput): SpreadVerdict {
  const enough = i.samples.length >= MIN_SAMPLES;
  const normalPts = enough ? median(i.samples) : null;
  const summary =
    normalPts === null
      ? `Spread now ${fmt(i.spreadPts)} pts.`
      : `Spread now ${fmt(i.spreadPts)} pts, normal ${fmt(normalPts)} pts.`;
  if (i.maxPts !== undefined && i.spreadPts > i.maxPts) {
    return {
      block: true,
      spreadPts: i.spreadPts,
      normalPts,
      summary,
      reason: `Spread is ${fmt(i.spreadPts)} pts, over this symbol's max of ${fmt(i.maxPts)} pts. Nothing was sent.`,
    };
  }
  if (normalPts === null) {
    return {
      block: false,
      spreadPts: i.spreadPts,
      normalPts,
      summary,
      ...(i.maxPts === undefined
        ? {
            warning: `Spread guard can't judge yet (${String(i.samples.length)} ticks seen, needs ${String(MIN_SAMPLES)}). Check the spread yourself.`,
          }
        : {}),
    };
  }
  const limit = i.k * normalPts;
  if (i.spreadPts > limit) {
    return {
      block: true,
      spreadPts: i.spreadPts,
      normalPts,
      summary,
      reason: `Spread is ${fmt(i.spreadPts)} pts, normal is ${fmt(normalPts)} pts (limit ${fmt(i.k)}× = ${fmt(limit)} pts). Nothing was sent.`,
    };
  }
  return { block: false, spreadPts: i.spreadPts, normalPts, summary };
}
