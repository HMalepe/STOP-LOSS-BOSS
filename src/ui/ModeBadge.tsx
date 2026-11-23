import { cx } from "./cx";

/** Mirrors the server's TradingMode. Defined here because src/ui may not import server code. */
export type Mode = "mock" | "demo" | "live";

const STYLES: Record<Mode, { label: string; className: string; description: string }> = {
  mock: {
    label: "MOCK",
    className: "border-mock/40 bg-mock/10 text-subtle",
    description: "Mock mode: simulated broker. No orders leave this app.",
  },
  demo: {
    label: "DEMO",
    className: "border-demo/50 bg-demo/10 text-demo",
    description: "Demo mode: real broker connection, demo account money.",
  },
  live: {
    label: "LIVE",
    className: "border-live/70 bg-live/15 text-live",
    description: "Live mode: real money.",
  },
};

/** Always visible at the top of every screen (07-UI-SPEC). LIVE gets a pulsing dot so it can't be missed. */
export function ModeBadge({ mode, className }: { readonly mode: Mode; readonly className?: string }) {
  const style = STYLES[mode];
  return (
    <span
      role="status"
      aria-label={style.description}
      title={style.description}
      data-mode={mode}
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 font-mono text-2xs font-semibold tracking-[0.14em]",
        style.className,
        className,
      )}
    >
      <span
        aria-hidden
        className={cx("size-1.5 rounded-full bg-current", mode === "live" && "animate-live-pulse")}
      />
      {style.label}
    </span>
  );
}
