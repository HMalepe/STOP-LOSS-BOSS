import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * A labelled number. `trend` colours AND marks it (arrow + sign), so meaning survives colour blindness and greyscale.
 * `hint` explains an unfamiliar metric in context.
 */
export function Metric({
  label,
  value,
  unit,
  trend,
  hint,
  size = "md",
  loading = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly trend?: "up" | "down" | "flat";
  readonly hint?: string;
  readonly size?: "md" | "lg";
  readonly loading?: boolean;
}) {
  const Icon =
    trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : trend === "flat" ? Minus : null;
  return (
    <div className="flex min-w-0 flex-col gap-1" title={hint}>
      <dt className="eyebrow truncate">{label}</dt>
      <dd
        className={cx(
          "num flex items-baseline gap-1 leading-none",
          size === "lg" ? "text-[1.75rem] font-medium tracking-tight" : "text-[1.0625rem]",
          trend === "up" ? "text-up" : trend === "down" ? "text-down" : "text-text",
        )}
      >
        {loading ? (
          <span className={cx("skeleton inline-block", size === "lg" ? "h-7 w-28" : "h-[1.0625rem] w-16")} />
        ) : (
          <>
            {Icon === null ? null : <Icon aria-hidden className="size-[0.9em] self-center" strokeWidth={2} />}
            {value}
            {unit === undefined ? null : <span className="text-xs text-muted">{unit}</span>}
          </>
        )}
      </dd>
    </div>
  );
}
