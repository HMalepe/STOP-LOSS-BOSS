/**
 * R9.4 spread guard, at EXECUTE time. Pure: samples (integer points) + the current spread → allow, refuse or warn.
 * Threshold = max(K × baseline, baseline + slack, floor): on raw accounts the median is 0 to 2 points, where 3 × 0 would block everything.
 * The baseline excludes spikes above max(2 × median, median + slack), so a long news widening can't become "normal".
 */
export interface SpreadConfig {
  readonly k: number;
  readonly minSlackPoints: number;
  readonly floorPoints: number;
  /** R9.4a. null = off. */
  readonly absoluteMaxPoints: number | null;
  readonly minSamples: number;
}

export const DEFAULT_SPREAD: SpreadConfig = {
  k: 3,
  minSlackPoints: 5,
  floorPoints: 10,
  absoluteMaxPoints: null,
  minSamples: 30,
};

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Baseline "normal" spread, robust to spikes. */
export function baseline(samples: readonly number[], slack: number): number {
  const m0 = median(samples);
  const cutoff = Math.max(2 * m0, m0 + slack);
  const kept = samples.filter((x) => x <= cutoff);
  return median(kept.length > 0 ? kept : samples);
}

export type SpreadVerdict =
  | { readonly ok: true; readonly warning?: string; readonly normal: number | null }
  | { readonly ok: false; readonly message: string; readonly normal: number | null };

export function spreadVerdict(
  current: number,
  samples: readonly number[],
  cfg: SpreadConfig = DEFAULT_SPREAD,
): SpreadVerdict {
  if (cfg.absoluteMaxPoints !== null && current > cfg.absoluteMaxPoints) {
    return {
      ok: false,
      normal: null,
      message: `Spread is ${String(current)} points; the limit is ${String(cfg.absoluteMaxPoints)}.`,
    };
  }
  if (samples.length < cfg.minSamples) {
    return cfg.absoluteMaxPoints === null
      ? {
          ok: true,
          normal: null,
          warning:
            "Not enough recent prices to know the normal spread, so the spread guard is off for this batch.",
        }
      : { ok: true, normal: null };
  }
  const normal = baseline(samples, cfg.minSlackPoints);
  const limit = Math.max(cfg.k * normal, normal + cfg.minSlackPoints, cfg.floorPoints);
  return current > limit
    ? {
        ok: false,
        normal,
        message: `Spread is ${String(current)} points; it's normally ${String(normal)}. Refused until it settles.`,
      }
    : { ok: true, normal };
}
