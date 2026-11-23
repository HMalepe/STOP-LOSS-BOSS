"use client";
import { buzz } from "./haptics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import { Fill } from "./Fill";

/**
 * LIVE confirm (07-UI-SPEC #7): press and hold for `holdMs`. The fill shows progress; letting go early cancels.
 * Keyboard: hold Space or Enter. Without `hold`, it's an ordinary button (MOCK/DEMO).
 */
export function HoldButton({
  hold,
  holdMs = 1_000,
  onConfirm,
  disabled = false,
  children,
}: {
  readonly hold: boolean;
  readonly holdMs?: number;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  const started = useRef<number | null>(null);
  const done = useRef(false);

  const stop = () => {
    if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    started.current = null;
    if (!done.current) setProgress(0);
  };
  const start = () => {
    if (disabled || started.current !== null) return;
    done.current = false;
    started.current = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - (started.current ?? t)) / holdMs);
      setProgress(p);
      if (p >= 1) {
        done.current = true;
        started.current = null;
        buzz(25);
        onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(
    () => () => {
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const base =
    "relative flex min-h-[3.25rem] w-full select-none items-center justify-center overflow-hidden rounded-md text-[0.9375rem] font-semibold disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint";
  if (!hold) {
    return (
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled}
        className={cx(base, "bg-accent text-accent-ink hover:bg-accent-strong")}
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="Press and hold to confirm"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => {
        e.preventDefault();
      }}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={stop}
      className={cx(base, "touch-none border border-live/60 bg-live/12 text-live")}
    >
      <Fill className="absolute inset-y-0 left-0 bg-live/45" fraction={progress} />
      <span className={cx("relative", progress > 0 && "text-text")}>
        {progress > 0 ? "Keep holding…" : children}
      </span>
    </button>
  );
}
