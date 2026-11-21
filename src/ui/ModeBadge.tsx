/** Mirrors the server's TradingMode. Defined here because src/ui may not import server code. */
export type Mode = "mock" | "demo" | "live";

const STYLES: Record<Mode, { label: string; className: string; description: string }> = {
  mock: {
    label: "MOCK",
    className: "border-mock/60 bg-mock/15 text-text",
    description: "Mock mode: simulated broker, no orders leave this app",
  },
  demo: {
    label: "DEMO",
    className: "border-warn/60 bg-warn/15 text-warn",
    description: "Demo mode: real broker connection, demo account money",
  },
  live: {
    label: "LIVE",
    className: "border-loss bg-loss/20 text-loss",
    description: "Live mode: real money",
  },
};

/** Always visible at the top of every screen (07-UI-SPEC). LIVE gets a pulsing dot so it can't be missed. */
export function ModeBadge({ mode }: { readonly mode: Mode }) {
  const style = STYLES[mode];
  return (
    <span
      role="status"
      aria-label={style.description}
      title={style.description}
      data-mode={mode}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold tracking-widest ${style.className}`}
    >
      {mode === "live" ? (
        <span aria-hidden className="size-2 rounded-full bg-loss animate-live-pulse" />
      ) : null}
      {style.label}
    </span>
  );
}
