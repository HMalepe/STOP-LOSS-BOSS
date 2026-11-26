/**
 * Execute (docs/04, §7, non-negotiables 1, 3, 6, 7).
 *
 * Order of checks, all BEFORE any broker call: owner's plan → not already executed → not expired → kill switch → mode
 * (live opt-in twice) → stored items unchanged (hash) → drift guard. Then one atomic claim, then the runner.
 *
 * Drift guard (§7): fresh quote (≤ 3 s old, R7.2) and positions.
 * - Any modify whose validity flipped since the preview (now invalid, or now frozen) → the WHOLE plan is refused with
 *   PRICE_MOVED: zero broker calls, re-preview.
 * - R7.1: a modify whose position's levels no longer match what the preview saw (changed elsewhere) is skipped up front,
 *   never sent, and reported in the response. The rest runs.
 * - Closed in the meantime: left in; the executor reports it per item (close-type items count it as done).
 */
import { BrokerError, type AccountTradeMode } from "@/broker/BrokerProvider";
import type { Clock } from "@/domain/clock";
import { formatPrice, fromPoints, toPoints } from "@/domain/price";
import { decideModify, marketFrom, quoteProblems } from "@/domain/rules";
import type { PlanItem, Skipped } from "@/domain/types";
import type { EntryItem } from "@/domain/entries";
import type { LadderItem } from "@/domain/ladder";
import { entryDrift } from "@/domain/entryDrift";
import { batchTags } from "@/domain/batch";
import { spreadVerdict } from "@/domain/spreadGuard";
import type { PendingExpiry } from "@/broker/BrokerProvider";
import type { ExecItem } from "@/execution/types";
import { loadEntryContext } from "./entryPlans";
import { SpreadSampler } from "./spread";
import type { ExecutionStore } from "@/execution/idempotency";
import type { JobRunner } from "@/execution/jobRunner";
import type { ExecEvent, ItemResult, Progress, Summary } from "@/execution/types";
import { canonical, type AuditEntry } from "../audit/audit";
import { sha256 } from "../auth/crypto";
import type { Db } from "../db/sql";
import { killSwitchState, tradingGate, type TradingAction } from "../killSwitch";
import { tradingModeGate } from "../tradingMode";
import { isPlanItem, itemsHash, MAX_QUOTE_AGE_MS, type StoredPlan } from "./plans";
import type { TradingServices } from "./services";

/** Non-negotiable 7 in the database: flipping the plan and inserting its execution happen together, once. */
export class PlanExpiredError extends Error {
  constructor() {
    super("plan expired before it could be claimed");
    this.name = "PlanExpiredError";
  }
}

export class DbExecutionStore implements ExecutionStore {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * Expiry is re-checked HERE, atomically with the claim (security review M2): the gates and drift guard before it can
   * take seconds on a slow broker, and a plan must never start sending after its 30 s.
   */
  claim(planId: string, newExecutionId: string): Promise<{ executionId: string; created: boolean }> {
    const now = new Date(this.#clock.now()).toISOString();
    return this.#db.tx(async (t) => {
      const won = await t.query(
        "update plans set status = 'executing' where id = $1 and status = 'created' and expires_at > $2 returning id",
        [planId, now],
      );
      if (won.length === 1) {
        await t.query("insert into executions (id, plan_id, started_at) values ($1, $2, $3)", [
          newExecutionId,
          planId,
          now,
        ]);
        return { executionId: newExecutionId, created: true };
      }
      const [existing] = await t.query<{ id: string }>("select id from executions where plan_id = $1", [
        planId,
      ]);
      if (existing === undefined) throw new PlanExpiredError();
      return { executionId: existing.id, created: false };
    });
  }
}

/**
 * Boot recovery: a run this process doesn't hold can't still be running. Mark it interrupted so status, history and
 * retry tell the truth (items with no result row are unknown: they may have been sent).
 */
export async function recoverInterrupted(
  db: Db,
  isLive: (executionId: string) => boolean,
): Promise<string[]> {
  const rows = await db.query<{ id: string }>("select id from executions where status = 'running'");
  const stale = rows.map((r) => r.id).filter((id) => !isLive(id));
  for (const id of stale) {
    await db.query(
      "update executions set status = 'interrupted', finished_at = now() where id = $1 and status = 'running'",
      [id],
    );
  }
  return stale;
}

export type ExecuteRefusal =
  | { readonly code: "PLAN_ALREADY_EXECUTED"; readonly message: string; readonly executionId: string | null }
  | {
      readonly code: "PLAN_EXPIRED" | "PRICE_STALE" | "SPREAD_TOO_WIDE" | "MARGIN_CHANGED" | "INTERNAL";
      readonly message: string;
    }
  | { readonly code: "TRADING_HALTED"; readonly message: string }
  | { readonly code: "LIVE_NOT_ENABLED" | "ACCOUNT_MODE_MISMATCH"; readonly message: string }
  | { readonly code: "PRICE_MOVED"; readonly message: string; readonly details: readonly Skipped[] };

export type ExecuteResult =
  | {
      readonly ok: true;
      readonly executionId: string;
      readonly skipped: readonly Skipped[];
      readonly count: number;
    }
  | ({ readonly ok: false } & ExecuteRefusal);

async function executionOf(db: Db, planId: string): Promise<string | null> {
  const [row] = await db.query<{ id: string }>("select id from executions where plan_id = $1", [planId]);
  return row?.id ?? null;
}

async function liveEnabled(db: Db, accountRef: string | null): Promise<boolean> {
  if (accountRef === null) return false;
  const [row] = await db.query<{ live_enabled: boolean }>(
    "select live_enabled from accounts where metaapi_account_id = $1",
    [accountRef],
  );
  return row?.live_enabled === true;
}

/** The kill switch and mode checks, shared by execute and close-now. */
export async function gates(
  svc: TradingServices,
  db: Db,
  action: TradingAction,
): Promise<ExecuteRefusal | null> {
  const halt = tradingGate(action, await killSwitchState(db, svc.envHalted));
  if (!halt.ok) return halt;
  const brokerTradeMode: AccountTradeMode | null =
    svc.broker.name === "mock" ? null : (await svc.broker.getAccount()).tradeMode;
  const mode = tradingModeGate({
    mode: svc.mode,
    liveEnabled: await liveEnabled(db, svc.accountRef),
    brokerTradeMode,
  });
  if (mode.ok) return null;
  // Closing only reduces risk: "live not enabled" never blocks it. (The account TYPE is checked first, so a wrong
  // account still refuses.) Applies to close-now and to a retry of its failed closes alike.
  if (action === "close" && mode.code === "LIVE_NOT_ENABLED") return null;
  return mode;
}

type Modify = Extract<PlanItem, { op: "modify" }>;

/** §7. Returns the items to run, the ones skipped up front (R7.1), or why the plan can't run at all. */
export async function driftGuard(
  svc: TradingServices,
  plan: StoredPlan,
): Promise<{ ok: true; run: PlanItem[]; skipped: Skipped[] } | { ok: false; refusal: ExecuteRefusal }> {
  const planItems = plan.items.filter(isPlanItem);
  const modifies = planItems.filter((i): i is Modify => i.op === "modify");
  if (modifies.length === 0) return { ok: true, run: planItems, skipped: [] };
  const symbol = plan.summary.symbol;
  // The broker may have widened stops/freeze levels since the preview (news): never check against a cached spec here.
  svc.specs.invalidate(symbol);
  const [positions, quote, spec] = await Promise.all([
    svc.broker.getPositions(),
    svc.broker.getQuote(symbol),
    svc.specs.get(symbol),
  ]);
  if (quoteProblems(quote).length > 0) {
    throw new BrokerError("BAD_DATA", `unusable quote for ${symbol}: ${quoteProblems(quote).join(", ")}`);
  }
  if (svc.clock.now() - quote.time > MAX_QUOTE_AGE_MS) {
    return {
      ok: false,
      refusal: {
        code: "PRICE_STALE",
        message: "The last price is too old to check against. Nothing was sent.",
      },
    };
  }
  const m = marketFrom(spec, quote);
  const byId = new Map(positions.map((p) => [p.id, p]));
  const same = (a: number | null, b: number | null) =>
    a === null || b === null ? a === b : toPoints(a, spec) === toPoints(b, spec);

  const skipped: Skipped[] = [];
  const moved: Skipped[] = [];
  const run = planItems.filter((item) => {
    if (item.op !== "modify") return true;
    const pos = byId.get(item.positionId);
    if (pos === undefined) return true; // closed meanwhile: reported per item
    if (!same(pos.sl, item.before.sl) || !same(pos.tp, item.before.tp)) {
      skipped.push({
        id: item.positionId,
        reason: "changed elsewhere since the preview (R7.1): not touched",
      });
      return false;
    }
    const d = decideModify(
      pos,
      {
        ...(item.sl === null ? {} : { sl: toPoints(item.sl, spec) }),
        ...(item.tp === null ? {} : { tp: toPoints(item.tp, spec) }),
      },
      m,
    );
    if (d.kind === "invalid") {
      moved.push({
        id: item.positionId,
        reason: d.violations
          .map(
            (v) =>
              `${v.level} must now be ${v.relation} ${formatPrice(fromPoints(v.boundary, spec), spec)} (${v.rule})`,
          )
          .join("; "),
      });
    } else if (d.kind === "skip" && d.rule === "R2.9") {
      moved.push({ id: item.positionId, reason: `now inside the freeze level (${d.frozen.level})` });
    }
    return true;
  });
  if (moved.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "PRICE_MOVED",
        message: `Price moved: ${String(moved.length)} of ${String(modifies.length)} changes are no longer valid. Nothing was sent. Preview again.`,
        details: moved,
      },
    };
  }
  return { ok: true, run, skipped };
}

/**
 * R9.7 + §7 for ENTRIES. After the kill switch / mode gates and the hash check, and BEFORE the first broker call:
 * quote age (R7.2) → spread guard (R9.4) → the stored levels against the live market (entry drift) → free margin vs what the preview needed.
 * Then every order is tagged with its batch identity (R9.1) and handed to the executor.
 */
export async function entryRun(
  svc: TradingServices,
  plan: StoredPlan,
): Promise<{ ok: true; run: ExecItem[]; skipped: Skipped[] } | { ok: false; refusal: ExecuteRefusal }> {
  const refuse = (refusal: ExecuteRefusal) => ({ ok: false as const, refusal });
  const entry = plan.summary.entry;
  const items = plan.items.filter(
    (i): i is EntryItem | LadderItem => i.op === "market" || i.op === "pending",
  );
  const batchSeq = entry?.batchSeq;
  if (entry === undefined || batchSeq === undefined || items.length !== plan.items.length) {
    return refuse({
      code: "INTERNAL",
      message: "This entry plan is missing its batch details. Nothing was sent.",
    });
  }
  const symbol = plan.summary.symbol;
  svc.specs.invalidate(symbol);
  const ctx = await loadEntryContext(svc, symbol);
  const now = svc.clock.now();
  if (now - ctx.quote.time > MAX_QUOTE_AGE_MS) {
    return refuse({
      code: "PRICE_STALE",
      message: "The last price is too old to check against. Nothing was sent.",
    });
  }
  if (quoteProblems(ctx.quote).length > 0) {
    throw new BrokerError("BAD_DATA", `unusable quote for ${symbol}: ${quoteProblems(ctx.quote).join(", ")}`);
  }
  // R9.4: at EXECUTE time, from this very quote.
  const sv = spreadVerdict(
    SpreadSampler.points(ctx.quote, ctx.spec),
    svc.entry.sampler.samples(symbol, now),
    svc.entry.spread,
  );
  if (!sv.ok) return refuse({ code: "SPREAD_TOO_WIDE", message: `${sv.message} Nothing was sent.` });
  // §7: every stored level must still be valid against the live market, or the WHOLE plan is refused.
  const drift = entryDrift(items, marketFrom(ctx.spec, ctx.quote));
  if (drift.length > 0) {
    return refuse({
      code: "PRICE_MOVED",
      message: "Price moved: some orders are no longer valid. Nothing was sent. Preview again.",
      details: drift,
    });
  }
  // R9.7: free margin must still cover what the preview needed.
  if (ctx.account.freeMargin < entry.margin.required) {
    return refuse({
      code: "MARGIN_CHANGED",
      message: `Free margin is now ${ctx.account.freeMargin.toFixed(2)}, below the ${entry.margin.required.toFixed(2)} this batch needs. Nothing was sent. Preview again.`,
    });
  }
  const expiry: PendingExpiry | undefined =
    entry.expiry === undefined
      ? undefined
      : entry.expiry.type === "SPECIFIED"
        ? { type: "SPECIFIED", time: entry.expiry.time ?? "" }
        : { type: entry.expiry.type };
  const run: ExecItem[] = items.map((i) => {
    const tags = batchTags(svc.entry.magicPrefix, batchSeq, i.index);
    return i.op === "market"
      ? {
          op: "market",
          req: { symbol: i.symbol, side: i.side, volume: i.volume, sl: i.sl, tp: i.tp, ...tags },
        }
      : {
          op: "pending",
          req: {
            symbol: i.symbol,
            type: i.type,
            volume: i.volume,
            openPrice: i.price,
            sl: i.sl,
            tp: i.tp,
            ...tags,
            ...(expiry === undefined ? {} : { expiry }),
          },
        };
  });
  return { ok: true, run, skipped: [] };
}

/** Writes the audit row for a finished run (same transaction as its summary). */
export type RecordComplete = (tx: Db, entry: AuditEntry) => Promise<unknown>;

/** R7.1 skips are visible from the start (status, history), not only once the run completes. */
export async function noteSkipped(db: Db, executionId: string, skipped: readonly Skipped[]): Promise<void> {
  await db.query("update executions set summary = $2::jsonb where id = $1", [
    executionId,
    JSON.stringify({ skippedUpFront: skipped }),
  ]);
}

export async function startExecution(
  svc: TradingServices,
  db: Db,
  plan: StoredPlan,
  record: RecordComplete,
): Promise<ExecuteResult> {
  const already = async (): Promise<ExecuteResult> => ({
    ok: false,
    code: "PLAN_ALREADY_EXECUTED",
    message: "This plan has already been executed.",
    executionId: await executionOf(db, plan.id),
  });
  if (plan.status !== "created") return already();
  if (plan.expiresAt <= svc.clock.now()) {
    return { ok: false, code: "PLAN_EXPIRED", message: "This preview expired (30 s). Preview again." };
  }
  const refused = await gates(svc, db, plan.summary.action);
  if (refused !== null) return { ok: false, ...refused };
  if (itemsHash(plan.items) !== plan.inputHash) {
    return {
      ok: false,
      code: "INTERNAL",
      message: "The stored plan doesn't match its preview. Nothing was sent.",
    };
  }
  const isEntry = plan.summary.action === "market" || plan.summary.action === "ladder";
  const drift = isEntry ? await entryRun(svc, plan) : await driftGuard(svc, plan);
  if (!drift.ok) return { ok: false, ...drift.refusal };
  const { skipped } = drift;

  let started;
  try {
    started = await svc.runner.start(plan.id, drift.run, { urgent: plan.summary.action === "close" });
  } catch (e) {
    if (e instanceof PlanExpiredError) {
      return { ok: false, code: "PLAN_EXPIRED", message: "This preview expired (30 s). Preview again." };
    }
    throw e;
  }
  if (!started.ok) return already();
  await noteSkipped(db, started.executionId, skipped);
  void persistResults(svc.runner, db, started.executionId, record);
  return { ok: true, executionId: started.executionId, skipped, count: drift.run.length };
}

/**
 * Item results land in execution_items as they finish; on completion the summary, the plan's final status and an
 * `execution.complete` audit row carrying a hash of every item result (the audit chain covers the outcomes, docs/05).
 * If saving fails, the run is marked interrupted (best effort) instead of being left "running" forever.
 */
export async function persistResults(
  runner: JobRunner,
  db: Db,
  executionId: string,
  record: RecordComplete,
): Promise<void> {
  const results: ItemResult[] = [];
  try {
    for await (const { event } of runner.events(executionId)) {
      if (event.type === "item") {
        const r = event.item;
        results.push(r);
        await db.query(
          "insert into execution_items (execution_id, idx, op, target_id, state, code, string_code, message, attempts, latency_ms, updated_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) on conflict (execution_id, idx) do update set state = excluded.state, code = excluded.code, string_code = excluded.string_code, message = excluded.message, attempts = excluded.attempts, latency_ms = excluded.latency_ms, updated_at = now()",
          [
            executionId,
            r.index,
            r.op,
            r.targetId,
            r.outcome,
            r.code,
            r.stringCode,
            r.message.slice(0, 500),
            r.attempts,
            Math.round(r.latencyMs),
          ],
        );
      } else {
        const summary = event.summary;
        await db.tx(async (t) => {
          await t.query(
            "update executions set status = 'complete', finished_at = $2, summary = coalesce(summary, '{}'::jsonb) || $3::jsonb where id = $1",
            [
              executionId,
              new Date(summary.finishedAt).toISOString(),
              JSON.stringify({ ...summary, outcome: outcomeOf(summary) }),
            ],
          );
          await t.query(
            "update plans set status = 'executed' where id = (select plan_id from executions where id = $1)",
            [executionId],
          );
          await record(t, {
            actor: "system",
            action: "execution.complete",
            subject: executionId,
            details: {
              outcome: outcomeOf(summary),
              total: summary.total,
              done: summary.done,
              failed: summary.failed,
              unknown: summary.unknown,
              skipped: summary.skipped,
              aborted: summary.aborted,
              resultsHash: sha256(canonical([...results].sort((a, b) => a.index - b.index).map(auditedItem))),
            },
          });
        });
      }
    }
  } catch {
    // Never touch the run itself. Leave a truthful terminal state instead of "running" forever.
    await db
      .query(
        "update executions set status = 'interrupted', finished_at = now() where id = $1 and status = 'running'",
        [executionId],
      )
      .catch(() => undefined);
  }
}

const auditedItem = (r: ItemResult) => ({
  index: r.index,
  op: r.op,
  targetId: r.targetId,
  outcome: r.outcome,
  code: r.code,
  attempts: r.attempts,
});

/**
 * Non-negotiable 6: "complete" alone never means "all done".
 * all_done · partial (something failed or is unknown) · aborted (stopped before everything was sent) · nothing.
 */
export function outcomeOf(p: Summary): "all_done" | "partial" | "aborted" | "nothing" {
  if (p.total === 0) return "nothing";
  if (p.aborted) return "aborted";
  return p.done === p.total ? "all_done" : "partial";
}

/** SSE (docs/04): progress {done,total,ok,failed} · item {...} · complete {summary} · error {code,message}. */
export function sseFrames(seq: number, event: ExecEvent): string {
  const frame = (name: string, data: unknown, id?: number) =>
    `${id === undefined ? "" : `id: ${String(id)}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  if (event.type === "complete") return frame("complete", { summary: event.summary }, seq);
  return frame("item", itemView(event.item)) + frame("progress", progressView(event.progress), seq);
}

export function itemView(r: ItemResult) {
  return {
    index: r.index,
    op: r.op,
    targetId: r.targetId,
    ok: r.outcome === "done",
    outcome: r.outcome,
    code: r.code,
    message: r.message,
    attempts: r.attempts,
    latencyMs: Math.round(r.latencyMs),
  };
}

export function progressView(p: Progress | Summary) {
  return {
    total: p.total,
    done: p.finished,
    ok: p.done,
    failed: p.failed,
    unknown: p.unknown,
    skipped: p.skipped,
  };
}
