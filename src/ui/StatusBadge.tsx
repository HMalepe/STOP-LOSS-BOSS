import type { ReactNode } from "react";
import { cx } from "./cx";

export type Tone = "neutral" | "accent" | "up" | "down" | "warn" | "info";

const TONE: Record<Tone, string> = {
  neutral: "border-line-strong text-subtle",
  accent: "border-accent/40 bg-accent/10 text-accent",
  up: "border-up/40 bg-up/10 text-up",
  down: "border-down/40 bg-down/10 text-down",
  warn: "border-warn/40 bg-warn/10 text-warn",
  info: "border-info/40 bg-info/10 text-info",
};

/** A compact label for a state. Always text, never colour alone. */
export function StatusBadge({
  tone = "neutral",
  icon,
  children,
}: {
  readonly tone?: Tone;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}
