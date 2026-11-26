/**
 * Close-now, retry-failed, history (docs/04, §4, §6).
 *
 * Close-now (R4.x): one call builds, records and runs the close plan on the urgent lane (other runs are aborted, the
 * limiter serves it first). It never depends on spec or quote (R4.7), isn't blocked by the kill switch (R4.2), and
 * isn't blocked by "live not enabled" (closing only reduces risk). It IS refused on the wrong account type.
 *
 * Retry-failed: a NEW plan of exactly the items that ended `failed`. Never `unknown` (ADR-0009: may have happened,
 * check manually). It goes through the normal execute path, so the drift guard and every gate apply again.
 */
import { z } from "zod";
import { buildPlan, type PlanDraft } from "@/domain/plan";
import { roundToTick } from "@/domain/price";
import type { PlanItem, PositionFilter, Quote, SymbolSpec } from "@/domain/types";
import type { Db } from "../db/sql";
import { gates, persistResults, type ExecuteRefusal, type RecordComplete } from "./executions";
import { isPlanItem, loadPlan, storePlan, type PlanSummary } from "./plans";
import type { TradingServices } from "./services";

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");

export const closeNowBody = z.strictObject({
  filter: z.strictObject({
    symbol: SYMBOL,
    side: z.enum(["ALL", "BUY", "SELL"]),
    magic: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    inProfitOnly: z.boolean().optional(),
  }),
  cancelPending: z.boolean().default(false),
  /** A typed confirmation, so a replayed or mis-wired request can't close everything. */
  confirm: z.literal("CLOSE", { error: 'Type "CLOSE" to confirm.' }),
});
export type CloseNowBody = z.infer<typeof closeNowBody>;

type Record_ = (tx: Db, summary: PlanSummary) => Promise<unknown>;

export type CloseNowResult =
  | { readonly ok: true; readonly executionId: string; readonly summary: PlanSummary }
  | { readonly ok: true; readonly executionId: string; readonly joined: true }
  | ({ readonly ok: false } & (
      ExecuteRefusal | { readonly code: "NOTHING_TO_CLOSE"; readonly message: string }
    ));

/** R4.7: a broken quote or spec read is a warning, never a blocker. */
async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function closeNow(
  svc: TradingServices,
  db: Db,
  userId: string,
  body: CloseNowBody,
  record: Record_,
  complete: RecordComplete,
): Promise<CloseNowResult> {
  // The gates waive the kill switch and "live not enabled" for closes, never a wrong account type.
  const refused = await gates(svc, db, "close");
  if (refused !== null) return { ok: false, ...refused };

  const f: PositionFilter = {
    symbol: body.filter.symbol,
    side: body.filter.side,
    ...(body.filter.magic === undefined ? {} : { magic: body.filter.magic }),
    ...(body.filter.inProfitOnly === undefined ? {} : { inProfitOnly: body.filter.inProfitOnly }),
  };
  const [positions, orders, quote, spec] = await Promise.all([
    svc.broker.getPositions(),
    svc.broker.getOrders(),
    optional<Quote>(svc.broker.getQuote(f.symbol)),
    optional<SymbolSpec>(svc.specs.get(f.symbol)),
  ]);
  const key = filterKey(f, body.cancelPending);
  // A double tap joins the close already running for the same filter instead of racing it (security review L3).
  for (const [executionId, k] of urgentFilters) {
    if (k !== key) continue;
    if (svc.runner.status(executionId)?.state === "running") return { ok: true, executionId, joined: true };
    urgentFilters.delete(executionId);
  }

  const req = { action: "close" as const, filter: f, cancelPending: body.cancelPending };
  const built = buildPlan(req, { positions, orders, quote, spec });
  if (!built.ok) return { ok: false, code: "NOTHING_TO_CLOSE", message: built.error.message };

  const summary = await storePlan(svc, db, userId, built.plan, req, positions, record);
  const started = await svc.runner.start(summary.id, built.plan.items, { urgent: true });
  // A fresh plan id can't already be claimed; this only guards against a broken store.
  if (!started.ok) return { ok: false, code: "INTERNAL", message: "Couldn't start the close. Try again." };
  urgentFilters.set(started.executionId, key);
  if (urgentFilters.size > 100) urgentFilters.delete(urgentFilters.keys().next().value ?? "");
  void persistResults(svc.runner, db, started.executionId, complete);
  return { ok: true, executionId: started.executionId, summary };
}

/** Running close-nows by filter (bounded). */
const urgentFilters = new Map<string, string>();
const filterKey = (f: PositionFilter, cancelPending: boolean) =>
  JSON.stringify([f.symbol, f.side, f.magic ?? null, f.inProfitOnly ?? false, cancelPending]);

export type RetryResult =
  | { readonly ok: true; readonly summary: PlanSummary }
  | {
      readonly ok: false;
      readonly code: "NOT_FOUND" | "STILL_RUNNING" | "NOTHING_TO_RETRY" | "NOT_FOR_ENTRIES";
      readonly message: string;
    };

const targetOfItem = (i: PlanItem) => (i.op === "cancel" ? i.orderId : i.positionId);

export async function retryFailed(
  svc: TradingServices,
  db: Db,
  userId: string,
  executionId: string,
  record: Record_,
): Promise<RetryResult> {
  if (!z.uuid().safeParse(executionId).success) {
    return { ok: false, code: "NOT_FOUND", message: "No such execution." };
  }
  const [exec] = await db.query<{ plan_id: string; status: string }>(
    "select e.plan_id, e.status from executions e join plans p on p.id = e.plan_id where e.id = $1 and p.user_id = $2",
    [executionId, userId],
  );
  if (exec === undefined) return { ok: false, code: "NOT_FOUND", message: "No such execution." };
  if (exec.status === "running") {
    if (svc.runner.status(executionId)?.state === "running") {
      return { ok: false, code: "STILL_RUNNING", message: "Still running. Retry once it finishes." };
    }
    // Not running anywhere: cut off (restart, or its results couldn't be saved). Say so, don't block forever.
    await db.query("update executions set status = 'interrupted', finished_at = now() where id = $1", [
      executionId,
    ]);
  }
  const original = await loadPlan(db, userId, exec.plan_id);
  if (original === null) return { ok: false, code: "NOT_FOUND", message: "No such execution." };

  const rows = await db.query<{ op: string; target_id: string; state: string; message: string }>(
    "select op, target_id, state, coalesce(message, '') as message from execution_items where execution_id = $1",
    [executionId],
  );
  // Retryable: failed, or never sent because the run was aborted (close-now, kill switch). An abort-skipped modify is a
  // position still without the level the owner asked for (QA review): it must not vanish as "nothing failed".
  const retryable = rows.filter(
    (r) =>
      r.state === "failed" || (r.state === "skipped" && r.message.startsWith("aborted before it was sent")),
  );
  const failed = new Set(retryable.map((r) => `${r.op}|${r.target_id}`));
  const withRow = new Set(rows.map((r) => `${r.op}|${r.target_id}`));
  // No result row at all = never reported: maybe sent (interrupted run). Unknown, never retried.
  const planItems = original.items.filter(isPlanItem);
  const missing = planItems.filter((i) => !withRow.has(`${i.op}|${targetOfItem(i)}`)).length;
  const unknown =
    rows.filter((r) => r.state === "unknown").length + (exec.status === "complete" ? 0 : missing);
  // Ids are unique within a plan (R0.3), so op + target picks out exactly the item that failed.
  const items = planItems.filter((i) => failed.has(`${i.op}|${targetOfItem(i)}`));
  if (items.length === 0) {
    return {
      ok: false,
      code: "NOTHING_TO_RETRY",
      message:
        unknown > 0
          ? `Nothing failed. ${String(unknown)} ended unknown: check those in MT5, they're never retried automatically.`
          : "Nothing failed.",
    };
  }
  if (original.summary.action === "market" || original.summary.action === "ladder") {
    // R9.8: only entries CONFIRMED absent may be re-sent (an unknown one might be on the book). That check arrives with batch management.
    return {
      ok: false,
      code: "NOT_FOR_ENTRIES",
      message:
        "Retrying failed entries needs a check that each one really didn't fill. Check MT5 and place them again for now.",
    };
  }
  const symbol = original.summary.symbol;
  const [quote, spec] = await Promise.all([
    optional<Quote>(svc.broker.getQuote(symbol)),
    optional<SymbolSpec>(svc.specs.get(symbol)),
  ]);
  const sides = items.flatMap((i) => (i.op === "cancel" ? [] : [i.side]));
  const draft: PlanDraft = {
    action: original.summary.action,
    symbol,
    quote:
      quote === null || spec === null
        ? null
        : { bid: roundToTick(quote.bid, spec), ask: roundToTick(quote.ask, spec), time: quote.time },
    items,
    skipped: [],
    breakdown: {
      buys: sides.filter((x) => x === "BUY").length,
      sells: sides.filter((x) => x === "SELL").length,
    },
    warnings: [
      `Retrying ${String(items.length)} that failed or weren't sent.`,
      ...(unknown > 0 ? [`${String(unknown)} ended unknown and are NOT retried: check them in MT5.`] : []),
    ],
  };
  const positions = await svc.broker.getPositions();
  const summary = await storePlan(svc, db, userId, draft, { retryOf: executionId }, positions, record);
  return { ok: true, summary };
}

export interface HistoryRow {
  readonly executionId: string;
  readonly planId: string;
  readonly action: string;
  readonly symbol: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly summary: unknown;
}

export const HISTORY_PAGE = 50;

/** Newest first. Cursor = "<startedAt ISO>|<executionId>" of the last row seen (stable under equal timestamps). */
export async function history(
  db: Db,
  userId: string,
  cursor: string | undefined,
): Promise<{ readonly items: readonly HistoryRow[]; readonly nextCursor: string | null } | null> {
  let after: [string, string] | null = null;
  if (cursor !== undefined) {
    const [at, id] = cursor.split("|");
    if (
      at === undefined ||
      id === undefined ||
      Number.isNaN(Date.parse(at)) ||
      !z.uuid().safeParse(id).success
    ) {
      return null;
    }
    after = [new Date(at).toISOString(), id];
  }
  const rows = await db.query<{
    id: string;
    plan_id: string;
    action: string;
    symbol: string;
    status: string;
    started_at: Date | string;
    finished_at: Date | string | null;
    summary: unknown;
  }>(
    `select e.id, e.plan_id, p.action, p.symbol, e.status, e.started_at, e.finished_at, e.summary
       from executions e join plans p on p.id = e.plan_id
      where p.user_id = $1 ${after === null ? "" : "and (e.started_at, e.id) < ($3::timestamptz, $4::uuid)"}
      order by e.started_at desc, e.id desc
      limit $2`,
    after === null ? [userId, HISTORY_PAGE + 1] : [userId, HISTORY_PAGE + 1, after[0], after[1]],
  );
  const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
  const items = rows.slice(0, HISTORY_PAGE).map((r) => ({
    executionId: r.id,
    planId: r.plan_id,
    action: r.action,
    symbol: r.symbol,
    status: r.status,
    startedAt: iso(r.started_at),
    finishedAt: r.finished_at === null ? null : iso(r.finished_at),
    summary: r.summary,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > HISTORY_PAGE && last !== undefined ? `${last.startedAt}|${last.executionId}` : null,
  };
}
