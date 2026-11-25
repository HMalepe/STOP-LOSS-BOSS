/**
 * R5.1 / R9.5: lots on the volume-step grid, computed in INTEGER STEPS. In floats 0.29 / 0.01 = 28.999…, so a naive
 * floor(v / step) turns 0.29 into 0.28 (found in the Phase 08 rules review). Nothing here compares raw float lots.
 */
import type { SymbolSpec } from "./types";

const EPS = 1e-9;

/** Decimal places needed to write a step exactly (0.01 → 2, 0.25 → 2, 1 → 0). */
export function stepDecimals(step: number): number {
  let d = 0;
  while (d < 10 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > EPS) d++;
  return d;
}

/** A whole number of steps → a clean lot value (no 0.30000000000000004). */
export function lotOfSteps(steps: number, step: number): number {
  return Number((steps * step).toFixed(stepDecimals(step)));
}

/** How many whole steps `v` is, or null if it isn't on the grid (within 1e-9 of a step). */
export function stepsOf(v: number, step: number): number | null {
  if (!(Number.isFinite(v) && v > 0 && Number.isFinite(step) && step > 0)) return null;
  const n = v / step;
  const r = Math.round(n);
  return Math.abs(n - r) <= EPS * Math.max(1, n) ? r : null;
}

/** Derived lots (R9.5 scaled ladders): round DOWN to the grid, in integer steps. */
export function roundDownToStep(v: number, step: number): number {
  const n = v / step;
  const nearest = Math.round(n);
  // Anything within 1e-9 of a step IS that step (0.29 / 0.01 = 28.999…).
  const steps = Math.abs(n - nearest) <= EPS * Math.max(1, n) ? nearest : Math.floor(n);
  return lotOfSteps(steps, step);
}

export type VolumeCheck =
  | { readonly ok: true; readonly steps: number; readonly volume: number }
  | { readonly ok: false; readonly message: string };

/** R5.1 for a TYPED lot: it must already be on the grid (never silently rounded) and inside min/max. */
export function checkVolume(
  v: number,
  spec: Pick<SymbolSpec, "volumeMin" | "volumeMax" | "volumeStep" | "symbol">,
): VolumeCheck {
  if (!(Number.isFinite(v) && v > 0)) return { ok: false, message: "Enter a lot size above zero." };
  const steps = stepsOf(v, spec.volumeStep);
  if (steps === null) {
    return {
      ok: false,
      message: `${String(v)} isn't a multiple of ${String(spec.volumeStep)} lots (the step for ${spec.symbol}).`,
    };
  }
  const volume = lotOfSteps(steps, spec.volumeStep);
  if (volume < spec.volumeMin - EPS) {
    return { ok: false, message: `The smallest lot for ${spec.symbol} is ${String(spec.volumeMin)}.` };
  }
  if (volume > spec.volumeMax + EPS) {
    return { ok: false, message: `The biggest lot for ${spec.symbol} is ${String(spec.volumeMax)}.` };
  }
  return { ok: true, steps, volume };
}
