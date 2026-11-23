"use client";
import { TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { cx } from "./cx";
import { HoldButton } from "./HoldButton";
import { countdown } from "./logic";
import type { Mode } from "./ModeBadge";
import { ModeBadge } from "./ModeBadge";
import { useNow } from "./useNow";

export interface SheetPlan {
  readonly sentence: string;
  readonly expiresAt: string;
  readonly count: number;
  readonly breakdown: readonly {
    readonly label: string;
    readonly value: string;
    readonly tone?: "up" | "down" | "warn";
  }[];
  readonly warnings: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * The last look before anything is sent (07-UI-SPEC #7): one plain sentence, the breakdown, warnings in amber, what was
 * skipped and why, and a 30 s ring. When it runs out the sheet closes itself (the server would refuse anyway).
 * LIVE: confirm is press-and-hold.
 */
export function ConfirmSheet({
  plan,
  mode,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
  onExpire,
}: {
  readonly plan: SheetPlan;
  readonly mode: Mode;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly error?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onExpire: () => void;
}) {
  const now = useNow();
  const left = countdown(plan.expiresAt, now);
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (left.expired && !busy) onExpire();
  }, [left.expired, busy, onExpire]);
  useEffect(() => {
    sheet.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
    };
  }, [busy, onCancel]);

  const R = 15;
  const C = 2 * Math.PI * R;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Cancel"
        tabIndex={-1}
        onClick={busy ? undefined : onCancel}
        className="absolute inset-0 bg-ink/70 backdrop-blur-[2px]"
      />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[1.25rem] border border-line-strong bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-24px_60px_-20px_rgb(0_0_0_/_0.7)] focus:outline-none sm:rounded-[1.25rem]"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong sm:hidden" />
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <ModeBadge mode={mode} />
              <span className="eyebrow">Confirm</span>
            </div>
            <h2 id={titleId} className="text-[1.0625rem] font-medium leading-snug text-text">
              {plan.sentence}
            </h2>
          </div>
          <div
            className="relative grid size-12 shrink-0 place-items-center"
            role="timer"
            aria-label={`Preview expires in ${String(left.seconds)} seconds`}
          >
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
              <circle cx="18" cy="18" r={R} fill="none" stroke="var(--color-line-strong)" strokeWidth="2.5" />
              <circle
                cx="18"
                cy="18"
                r={R}
                fill="none"
                stroke={left.seconds <= 5 ? "var(--color-warn)" : "var(--color-accent)"}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - left.fraction)}
                className="transition-[stroke-dashoffset] duration-200 ease-linear"
              />
            </svg>
            <span className={cx("num text-sm", left.seconds <= 5 ? "text-warn" : "text-text")}>
              {left.seconds}
            </span>
          </div>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 pb-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-line bg-bg/50 p-4 sm:grid-cols-3">
            {plan.breakdown.map((b) => (
              <div key={b.label} className="flex flex-col gap-1">
                <dt className="eyebrow">{b.label}</dt>
                <dd
                  className={cx(
                    "num text-base",
                    b.tone === "up"
                      ? "text-up"
                      : b.tone === "down"
                        ? "text-down"
                        : b.tone === "warn"
                          ? "text-warn"
                          : "text-text",
                  )}
                >
                  {b.value}
                </dd>
              </div>
            ))}
          </dl>

          {plan.warnings.length === 0 ? null : (
            <ul className="flex flex-col gap-2">
              {plan.warnings.map((w) => (
                <li
                  key={w}
                  className="flex gap-2.5 rounded-md border border-warn/35 bg-warn/8 px-3 py-2.5 text-sm text-subtle"
                >
                  <TriangleAlert
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-warn"
                    strokeWidth={1.75}
                  />
                  {w}
                </li>
              ))}
            </ul>
          )}

          {plan.skipped.length === 0 ? null : (
            <details className="rounded-md border border-line text-sm">
              <summary className="flex min-h-11 cursor-pointer items-center px-3 text-muted">
                {plan.skipped.length} left alone · why
              </summary>
              <ul className="max-h-40 divide-y divide-line/60 overflow-y-auto border-t border-line">
                {plan.skipped.map((x) => (
                  <li key={x.id} className="flex gap-3 px-3 py-2">
                    <span className="num text-muted">#{x.id}</span>
                    <span className="text-subtle">{x.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {error}
        </div>

        <footer className="flex gap-2 border-t border-line bg-surface px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[3.25rem] rounded-md px-5 text-[0.9375rem] font-medium text-subtle transition-colors hover:bg-raised hover:text-text disabled:text-faint"
          >
            <span className="flex items-center gap-1.5">
              <X aria-hidden className="size-4" />
              Cancel
            </span>
          </button>
          <div className="flex-1">
            <HoldButton hold={mode === "live"} onConfirm={onConfirm} disabled={busy || left.expired}>
              {busy ? "Sending…" : mode === "live" ? `Hold to ${confirmLabel.toLowerCase()}` : confirmLabel}
            </HoldButton>
          </div>
        </footer>
      </div>
    </div>
  );
}
