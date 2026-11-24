"use client";
import { ChevronDown, History as HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type ApiError, type HistoryRow } from "@/ui/api";
import { Panel } from "@/ui/AppShell";
import { Button } from "@/ui/Button";
import { cx } from "@/ui/cx";
import { dateTime } from "@/ui/logic";
import { EmptyState, ErrorState } from "@/ui/States";
import { StatusBadge, type Tone } from "@/ui/StatusBadge";

const ACTION: Record<string, string> = {
  levels: "Set SL/TP",
  closeAt: "Close at price",
  close: "Close all now",
  breakeven: "Break-even",
  lock: "Lock profit",
};

/** Non-negotiable 6 on screen: the badge says how it ended, never a bare "complete". */
function outcome(r: HistoryRow): { label: string; tone: Tone } {
  if (r.status === "running") return { label: "Running", tone: "accent" };
  if (r.status === "interrupted") return { label: "Interrupted · check MT5", tone: "warn" };
  switch (r.summary?.outcome) {
    case "all_done":
      return { label: "All done", tone: "up" };
    case "aborted":
      return { label: "Stopped early", tone: "warn" };
    case "nothing":
      return { label: "Nothing sent", tone: "neutral" };
    case undefined:
    default:
      return (r.summary?.unknown ?? 0) > 0
        ? { label: "Unknown · check MT5", tone: "warn" }
        : { label: "Partly done", tone: "down" };
  }
}

export function HistoryList() {
  const [rows, setRows] = useState<readonly HistoryRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    const r = await api.history(cursor);
    setLoading(false);
    if (!r.ok) {
      setError(r);
      return;
    }
    setError(null);
    setRows((xs) => (cursor === undefined ? r.data.items : [...(xs ?? []), ...r.data.items]));
    setNext(r.data.nextCursor);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(t);
    };
  }, [load]);

  if (error !== null && rows === null) {
    return (
      <ErrorState
        title={error.message}
        action={
          <Button size="sm" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <Panel
      title="Batches"
      meta={rows === null ? "loading" : `${String(rows.length)} shown · newest first`}
      flush
    >
      {rows === null ? (
        <div className="flex flex-col gap-3 p-4">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="skeleton h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon aria-hidden className="size-5" strokeWidth={1.5} />}
          title="No batches yet"
          body="When you run an action from the desk, it appears here with what succeeded, what failed and why."
        />
      ) : (
        <ul className="divide-y divide-line/60">
          {rows.map((r) => {
            const o = outcome(r);
            const s = r.summary;
            const expanded = open === r.executionId;
            return (
              <li key={r.executionId}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => {
                    setOpen(expanded ? null : r.executionId);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-text">
                      {ACTION[r.action] ?? r.action} <span className="num text-muted">{r.symbol}</span>
                    </p>
                    <p className="num text-xs text-muted">
                      {dateTime(r.startedAt)}
                      {s?.total === undefined ? "" : ` · ${String(s.done ?? 0)}/${String(s.total)}`}
                    </p>
                  </div>
                  <StatusBadge tone={o.tone}>{o.label}</StatusBadge>
                  <ChevronDown
                    aria-hidden
                    className={cx(
                      "size-4 shrink-0 text-faint transition-transform",
                      expanded && "rotate-180",
                    )}
                  />
                </button>
                {expanded ? (
                  <dl className="grid grid-cols-4 gap-2 border-t border-line/60 bg-bg/40 px-4 py-3 text-center">
                    {(
                      [
                        ["Done", s?.done, "text-up"],
                        ["Failed", s?.failed, "text-down"],
                        ["Unknown", s?.unknown, "text-warn"],
                        ["Not sent", s?.skipped, "text-muted"],
                      ] as const
                    ).map(([label, n, cls]) => (
                      <div key={label}>
                        <dt className="eyebrow">{label}</dt>
                        <dd className={cx("num text-base", (n ?? 0) > 0 ? cls : "text-faint")}>{n ?? "—"}</dd>
                      </div>
                    ))}
                    <p className="col-span-4 num text-left text-2xs text-faint">run {r.executionId}</p>
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {next === null ? null : (
        <div className="border-t border-line p-3">
          <Button block loading={loading} onClick={() => void load(next)}>
            Load older
          </Button>
        </div>
      )}
    </Panel>
  );
}
