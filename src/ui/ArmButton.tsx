"use client";
import { buzz } from "./haptics";
import { Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";

const ARM_MS = 4_000;

/**
 * Close All Now (07-UI-SPEC #2): first tap ARMS ("Tap again to close 214", 4 s), second tap FIRES. A pocket tap can't
 * close everything, and a real panic needs only two taps, no sheet. Haptic tick where supported.
 */
export function ArmButton({
  label,
  armedLabel,
  onFire,
  disabled = false,
  busy = false,
}: {
  readonly label: string;
  readonly armedLabel: string;
  readonly onFire: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const tap = () => {
    if (!armed) {
      setArmed(true);
      buzz(15);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setArmed(false);
      }, ARM_MS);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    buzz([30, 40, 30]);
    onFire();
  };
  return (
    <button
      type="button"
      onClick={tap}
      disabled={disabled || busy}
      aria-live="assertive"
      data-armed={armed || undefined}
      className={cx(
        "relative flex min-h-[3.25rem] w-full items-center justify-center gap-2 overflow-hidden rounded-md text-[0.9375rem] font-semibold tracking-wide",
        "transition-[background-color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint",
        armed
          ? "bg-danger text-ink shadow-[0_0_0_3px_rgb(240_106_95_/_0.35)]"
          : "border border-danger/60 bg-danger/14 text-danger hover:bg-danger/22",
      )}
    >
      {armed ? (
        <span aria-hidden className="absolute inset-0 animate-[arm-drain_4s_linear_forwards] bg-ink/15" />
      ) : null}
      <Zap aria-hidden className="relative size-4" strokeWidth={2.25} />
      <span className="relative">{busy ? "Closing…" : armed ? armedLabel : label}</span>
    </button>
  );
}
