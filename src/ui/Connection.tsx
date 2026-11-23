import { cx } from "./cx";

export type Link = "live" | "stale" | "down";

const COPY: Record<Link, { label: string; dot: string; text: string }> = {
  live: { label: "Connected", dot: "bg-up", text: "text-subtle" },
  stale: { label: "Prices delayed", dot: "bg-warn", text: "text-warn" },
  down: { label: "Broker offline", dot: "bg-down", text: "text-down" },
};

/** Connection + data freshness in one glance: a dot AND words (never colour alone). */
export function Connection({ state, age }: { readonly state: Link; readonly age?: string }) {
  const c = COPY[state];
  return (
    <span role="status" className={cx("inline-flex items-center gap-1.5 text-xs", c.text)}>
      <span aria-hidden className={cx("size-1.5 rounded-full", c.dot)} />
      <span className="hidden sm:inline">{c.label}</span>
      <span className="sr-only sm:hidden">{c.label}</span>
      {age === undefined ? null : <span className="num text-muted">{age}</span>}
    </span>
  );
}
