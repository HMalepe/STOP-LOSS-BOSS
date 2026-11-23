"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiError, type Position, type StateView } from "@/ui/api";

/** Polls the desk state + positions for one symbol every second while the tab is visible. */
export function useDeskData(symbol: string) {
  // Everything is tagged with the symbol it was fetched for: after a symbol switch, old data is simply not shown.
  const [data, setData] = useState<{
    symbol: string;
    state: StateView;
    positions: readonly Position[];
  } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const inFlight = useRef(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const [s, p] = await Promise.all([api.state(symbol), api.positions(symbol)]);
    inFlight.current = false;
    if (s.ok && p.ok) {
      setData({ symbol, state: s.data, positions: p.data.items });
      setError(null);
      setLastOk(Date.now());
    } else {
      const e = s.ok ? (p.ok ? null : p) : s;
      if (e !== null) setError({ status: e.status, code: e.code, message: e.message });
      if (e?.status === 401) router.replace("/login");
    }
  }, [symbol, router]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  const current = data?.symbol === symbol ? data : null;
  return { state: current?.state ?? null, positions: current?.positions ?? null, error, lastOk, refresh };
}

export interface RunItem {
  readonly index: number;
  readonly targetId: string;
  readonly op: string;
  readonly outcome: "done" | "failed" | "unknown" | "skipped";
  readonly message: string;
  readonly attempts: number;
  readonly latencyMs: number;
}
export interface RunProgress {
  readonly total: number;
  readonly done: number;
  readonly ok: number;
  readonly failed: number;
  readonly unknown: number;
  readonly skipped: number;
}

/** Follows one execution over SSE (resumes after a dropped connection; the browser sends Last-Event-ID). */
export function useRun(executionId: string | null, total: number) {
  // Tagged with the execution it belongs to; a new run starts from empty without resetting state in an effect.
  const [run, setRun] = useState<{
    id: string;
    items: readonly RunItem[];
    progress: RunProgress | null;
    finished: boolean;
  } | null>(null);

  useEffect(() => {
    if (executionId === null) return;
    const id = executionId;
    const update = (
      f: (r: {
        id: string;
        items: readonly RunItem[];
        progress: RunProgress | null;
        finished: boolean;
      }) => typeof r,
    ) => {
      setRun((r) => f(r?.id === id ? r : { id, items: [], progress: null, finished: false }));
    };
    const es = new EventSource(`/api/executions/${id}/stream`);
    es.addEventListener("item", (e) => {
      const it = JSON.parse((e as MessageEvent<string>).data) as RunItem;
      update((r) => (r.items.some((x) => x.index === it.index) ? r : { ...r, items: [...r.items, it] }));
    });
    es.addEventListener("progress", (e) => {
      const p = JSON.parse((e as MessageEvent<string>).data) as RunProgress;
      update((r) => ({ ...r, progress: p }));
    });
    es.addEventListener("complete", () => {
      update((r) => ({ ...r, finished: true }));
      es.close();
    });
    es.addEventListener("error", () => {
      // A server "error" frame or a dropped link that won't resume: stop following; the summary is in History.
      if (es.readyState === EventSource.CLOSED) update((r) => ({ ...r, finished: true }));
    });
    return () => {
      es.close();
    };
  }, [executionId]);

  const mine = run?.id === executionId ? run : null;
  return {
    items: mine?.items ?? [],
    progress: mine?.progress ?? { total, done: 0, ok: 0, failed: 0, unknown: 0, skipped: 0 },
    finished: mine?.finished ?? false,
  };
}
