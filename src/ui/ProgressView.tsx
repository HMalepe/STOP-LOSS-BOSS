"use client";
import { CircleCheck, CircleHelp, CircleSlash, CircleX, RotateCcw } from "lucide-react";
import { Button } from "./Button";
import { cx } from "./cx";
import { Fill } from "./Fill";
import { progressHeadline, type ProgressLike } from "./logic";

export interface ItemView {
  readonly index: number;
  readonly targetId: string;
  readonly op: string;
  readonly outcome: "done" | "failed" | "unknown" | "skipped";
  readonly message: string;
  readonly attempts: number;
  readonly latencyMs: number;
}

const OUTCOME = {
  done: { icon: CircleCheck, cls: "text-up", label: "Done" },
  failed: { icon: CircleX, cls: "text-down", label: "Failed" },
  unknown: { icon: CircleHelp, cls: "text-warn", label: "Unknown" },
  skipped: { icon: CircleSlash, cls: "text-muted", label: "Not sent" },
} as const;

/**
 * Execution view (07-UI-SPEC #8): one honest headline, a segmented bar (ok · failed · unknown · not sent), counters,
 * the streaming list with problems first, and "Retry failed (n)" when it's over.
 */
export function ProgressView({
  progress,
  finished,
  items,
  onRetry,
  onDone,
}: {
  readonly progress: ProgressLike;
  readonly finished: boolean;
  readonly items: readonly ItemView[];
  readonly onRetry?: () => void;
  readonly onDone?: () => void;
}) {
  const head = progressHeadline(progress, finished);
  const pct = (n: number) => (progress.total === 0 ? 0 : n / progress.total);
  const retryable = progress.failed + progress.skipped;
  const sorted = [...items].sort((a, b) => rank(a.outcome) - rank(b.outcome) || b.index - a.index);
  return (
    <section aria-label="Execution progress" className="panel flex flex-col overflow-hidden">
      <div className="flex flex-col gap-3 p-4">
        <p
          role="status"
          aria-live="polite"
          className={cx(
            "text-[1.0625rem] font-medium",
            head.tone === "up"
              ? "text-up"
              : head.tone === "down"
                ? "text-down"
                : head.tone === "warn"
                  ? "text-warn"
                  : "text-text",
          )}
        >
          {head.text}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label="Orders finished"
          className="flex h-2 overflow-hidden rounded-full bg-raised"
        >
          <Fill className="bg-up transition-[width] duration-200" fraction={pct(progress.ok)} />
          <Fill className="bg-down transition-[width] duration-200" fraction={pct(progress.failed)} />
          <Fill className="bg-warn transition-[width] duration-200" fraction={pct(progress.unknown)} />
          <Fill className="bg-faint transition-[width] duration-200" fraction={pct(progress.skipped)} />
        </div>
        <dl className="grid grid-cols-4 gap-2 text-center">
          {(
            [
              ["Done", progress.ok, "text-up"],
              ["Failed", progress.failed, "text-down"],
              ["Unknown", progress.unknown, "text-warn"],
              ["Not sent", progress.skipped, "text-muted"],
            ] as const
          ).map(([label, n, cls]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className="eyebrow">{label}</dt>
              <dd className={cx("num text-lg", n > 0 ? cls : "text-faint")}>{n}</dd>
            </div>
          ))}
        </dl>
      </div>

      {sorted.length === 0 ? null : (
        <ul
          aria-label="Results"
          className="max-h-80 divide-y divide-line/60 overflow-y-auto border-t border-line"
        >
          {sorted.map((it) => {
            const o = OUTCOME[it.outcome];
            return (
              <li key={it.index} className="flex items-start gap-3 px-4 py-2.5">
                <o.icon
                  aria-label={o.label}
                  className={cx("mt-0.5 size-4 shrink-0", o.cls)}
                  strokeWidth={1.75}
                />
                <div className="min-w-0 flex-1">
                  <p className="num text-sm text-text">
                    #{it.targetId} <span className="text-muted">{it.op}</span>
                  </p>
                  {it.outcome === "done" ? null : <p className="text-xs text-muted">{it.message}</p>}
                </div>
                <span className="num shrink-0 text-xs text-faint">
                  {it.latencyMs} ms{it.attempts > 1 ? ` · ${String(it.attempts)}×` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {finished ? (
        <div className="flex gap-2 border-t border-line p-3">
          {onRetry !== undefined && retryable > 0 ? (
            <Button
              variant="primary"
              icon={<RotateCcw aria-hidden className="size-4" />}
              onClick={onRetry}
              className="flex-1"
            >
              Retry failed ({retryable})
            </Button>
          ) : null}
          {onDone === undefined ? null : (
            <Button onClick={onDone} className={retryable > 0 && onRetry !== undefined ? "" : "flex-1"}>
              Done
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function rank(o: ItemView["outcome"]): number {
  return o === "unknown" ? 0 : o === "failed" ? 1 : o === "skipped" ? 2 : 3;
}
