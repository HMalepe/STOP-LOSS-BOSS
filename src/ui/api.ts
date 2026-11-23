/**
 * Typed fetch wrappers for the desk (docs/04, docs/openapi.json). src/ui can't import server code, so the shapes are
 * mirrored here; the contract tests on the server keep them honest.
 */
export interface Quote {
  readonly bid: number;
  readonly ask: number;
  readonly time: number;
}
export interface Spec {
  readonly digits: number;
  readonly point: number;
}
export interface SideSummary {
  readonly count: number;
  readonly lots: number;
  readonly profit: number;
}
export interface StateView {
  readonly mode: "mock" | "demo" | "live";
  readonly killSwitch: { readonly halted: boolean; readonly byEnv: boolean; readonly byDb: boolean };
  readonly account: {
    readonly currency: string;
    readonly equity: number;
    readonly marginLevel: number | null;
  };
  readonly symbols: readonly {
    readonly symbol: string;
    readonly buy: SideSummary;
    readonly sell: SideSummary;
    readonly orders: number;
  }[];
  readonly focus?: { readonly symbol: string; readonly quote: Quote; readonly spec: Spec };
}
export interface Position {
  readonly id: string;
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly volume: number;
  readonly openPrice: number;
  readonly sl: number | null;
  readonly tp: number | null;
  readonly profit: number;
}
export interface PlanSummary {
  readonly id: string;
  readonly action: "levels" | "closeAt" | "close" | "breakeven" | "lock";
  readonly symbol: string;
  readonly expiresAt: string;
  readonly count: number;
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly breakdown: {
    readonly buys: number;
    readonly sells: number;
    readonly asSL?: number;
    readonly asTP?: number;
    readonly cancels?: number;
    readonly totalLots?: number;
  };
  readonly warnings: readonly string[];
}
export interface ApiError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}
export type Result<T> = { readonly ok: true; readonly data: T } | ({ readonly ok: false } & ApiError);

async function call<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.ok) return { ok: true, data: body as T };
    const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    return {
      ok: false,
      status: res.status,
      code: e?.code ?? "INTERNAL",
      message: e?.message ?? "Something went wrong. Nothing was sent.",
      ...(e?.details === undefined ? {} : { details: e.details }),
    };
  } catch {
    return { ok: false, status: 0, code: "OFFLINE", message: "Can't reach the server. Nothing was sent." };
  }
}

const post = <T>(path: string, body: unknown) =>
  call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const api = {
  state: (symbol: string) => call<StateView>(`/api/state?symbol=${encodeURIComponent(symbol)}`),
  positions: (symbol: string) =>
    call<{ items: Position[]; total: number; nextCursor: string | null }>(
      `/api/positions?symbol=${encodeURIComponent(symbol)}`,
    ),
  preview: (body: unknown) => post<PlanSummary>("/api/plans", body),
  execute: (planId: string) =>
    post<{ executionId: string; count: number; skipped: PlanSummary["skipped"] }>(
      `/api/plans/${planId}/execute`,
      {},
    ),
  retryFailed: (executionId: string) => post<PlanSummary>(`/api/executions/${executionId}/retry-failed`, {}),
  closeNow: (symbol: string) =>
    post<{ executionId: string }>("/api/close-now", {
      filter: { symbol, side: "ALL" },
      cancelPending: true,
      confirm: "CLOSE",
    }),
};
