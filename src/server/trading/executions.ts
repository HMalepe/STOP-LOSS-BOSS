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
import { BrokerError, type AccountTradeMode, type BrokerProvider } from "@/broker/BrokerProvider";
import type { Clock } from "@/domain/clock";
import { formatPrice, fromPoints, toPoints } from "@/domain/price";
import { decideModify, marketFrom, quoteProblems } from "@/domain/rules";
import type { PlanItem, Skipped } from "@/domain/types";
import { entryProblems, type MarketEntryItem, type PendingEntryItem } from "@/domain/entries";
import type { ExecutionStore } from "@/execution/idempotency";
import type { JobRunner } from "@/execution/jobRunner";
import {
  targetOf,
  type ExecEvent,
  type ExecItem,
  type ItemResult,
  type Progress,
  type Summary,
} from "@/execution/types";
import { canonical, type AuditEntry } from "../audit/audit";
import { sha256 } from "../auth/crypto";
import type { Db } from "../db/sql";
import { killSwitchState, tradingGate, type TradingAction } from "../killSwitch";
import { tradingModeGate } from "../tradingMode";
import { itemsHash, MAX_QUOTE_AGE_MS, spreadCheck, type StoredItem, type StoredPlan } from "./plans";
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
  claim(
    planId: string,
    newExecutionId: string,
    items: readonly ExecItem[] = [],
  ): Promise<{ executionId: string; created: boolean }> {
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
        // Restart recovery: every item exists as "pending" from the moment the plan is claimed.
        if (items.length > 0) {
          await t.query(
            "insert into execution_items (execution_id, idx, op, target_id, state) select $1, x.i - 1, x.op, x.target, 'pending' from unnest($2::text[], $3::text[]) with ordinality as x(op, target, i)",
            [newExecutionId, items.map((i) => i.op), items.map(targetOf)],
          );
        }
        return { executionId: newExecutionId, created: true };
      }
      const [existing] = await t.query<{ id: string }>("select id from executions where plan_id = $1", [
        planId,
      ]);
      if (existing === undefined) throw new PlanExpiredError();
      return { executionId: existing.id, created: false };
    });
  }

  /** Item `index` is about to be sent. Only a pending row moves: a result that already landed is never overwritten. */
  async markSending(executionId: string, index: number): Promise<void> {
    await this.#db.query(
      "update execution_items set state = 'sending', updated_at = now() where execution_id = $1 and idx = $2 and state = 'pending'",
      [executionId, index],
    );
  }
}

/** Starts with "not sent", so retry-failed picks it up. */
export const NOT_SENT_RESTART = "not sent: the server restarted before it was sent";
export const UNKNOWN_RESTART =
  "the server restarted while sending: it may or may not have happened, check it in MT5";

/**
 * A run no process holds anymore. One transaction: the run is interrupted, items never picked up are "not sent"
 * (skipped, retryable), items caught mid-send are unknown (may have happened: never retried automatically).
 */
export async function markInterrupted(db: Db, executionId: string): Promise<boolean> {
  return db.tx(async (t) => {
    const hit = await t.query(
      "update executions set status = 'interrupted', finished_at = now() where id = $1 and status = 'running' returning id",
      [executionId],
    );
    if (hit.length === 0) return false;
    await t.query(
      "update execution_items set state = 'skipped', message = $2, updated_at = now() where execution_id = $1 and state = 'pending'",
      [executionId, NOT_SENT_RESTART],
    );
    await t.query(
      "update execution_items set state = 'unknown', message = $2, updated_at = now() where execution_id = $1 and state = 'sending'",
      [executionId, UNKNOWN_RESTART],
    );
    return true;
  });
}

/** Messages of entries after a restart lookup. Not UNKNOWN_RESTART, so a second boot doesn't look them up again. */
const FOUND = "found in MT5 after a restart";
const NOT_FOUND =
  "not found in MT5 after a restart: most likely never placed, but a late fill can't be ruled out. Check MT5 before re-firing.";
const IN_FLIGHT = "still being processed by MT5 after a restart: check MT5 in a minute.";

/**
 * ADR-0009 after a restart: entries left "sending" (now unknown with UNKNOWN_RESTART) are looked up by clientId.
 * Found as a position or pending order → done, with the ticket. Not found / in flight → stay unknown with a clearer
 * message: "not found" seconds after a crash isn't proof it never landed, so it's never turned into "not sent".
 * A broker that can't answer changes nothing. Never throws.
 */
export async function reconcileRestartedEntries(
  db: Db,
  broker: Pick<BrokerProvider, "reconcile">,
): Promise<{ checked: number; found: number }> {
  try {
    // The batch magic comes from the stored plan's item at the same index (R9.1: magic AND clientId together).
    const rows = await db.query<{
      execution_id: string;
      idx: number;
      target_id: string;
      magic: string | null;
    }>(
      "select ei.execution_id, ei.idx, ei.target_id, (p.items -> ei.idx) ->> 'magic' as magic from execution_items ei join executions e on e.id = ei.execution_id join plans p on p.id = e.plan_id where ei.state = 'unknown' and ei.op in ('market', 'pending') and ei.message = $1",
      [UNKNOWN_RESTART],
    );
    if (rows.length === 0) return { checked: 0, found: 0 };
    // An item whose plan can't tell us its magic can't be matched safely: it stays unknown.
    const keyed = rows.flatMap((r) =>
      Number.isSafeInteger(Number(r.magic)) && r.magic !== null
        ? [{ r, key: { clientId: r.target_id, magic: Number(r.magic) } }]
        : [],
    );
    if (keyed.length === 0) return { checked: 0, found: 0 };
    const where = await broker.reconcile(keyed.map((k) => k.key));
    let found = 0;
    for (const { r } of keyed) {
      const w = where.get(r.target_id);
      if (w === undefined) continue;
      const [state, message] =
        w.status === "position"
          ? ["done", `${FOUND}: position ${w.positionIds.join(", ")}`]
          : w.status === "order"
            ? ["done", `${FOUND}: order ${w.orderIds.join(", ")}`]
            : w.status === "inFlight"
              ? ["unknown", IN_FLIGHT]
              : ["unknown", NOT_FOUND];
      if (state === "done") found += 1;
      await db.query(
        "update execution_items set state = $3, message = $4, updated_at = now() where execution_id = $1 and idx = $2 and message = $5",
        [r.execution_id, r.idx, state, message, UNKNOWN_RESTART],
      );
    }
    return { checked: keyed.length, found };
  } catch {
    return { checked: 0, found: 0 };
  }
}

/** Boot recovery: a run this process doesn't hold can't still be running. */
export async function recoverInterrupted(
  db: Db,
  isLive: (executionId: string) => boolean,
): Promise<string[]> {
  const rows = await db.query<{ id: string }>("select id from executions where status = 'running'");
  const stale = rows.map((r) => r.id).filter((id) => !isLive(id));
  for (const id of stale) await markInterrupted(db, id);
  return stale;
}

export type ExecuteRefusal =
  | { readonly code: "PLAN_ALREADY_EXECUTED"; readonly message: string; readonly executionId: string | null }
  | { readonly code: "PLAN_EXPIRED" | "PRICE_STALE" | "INTERNAL"; readonly message: string }
  | { readonly code: "SHUTTING_DOWN"; readonly message: string }
  | { readonly code: "SPREAD_TOO_WIDE"; readonly message: string }
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
type Entry = MarketEntryItem | PendingEntryItem;
const isEntry = (i: StoredItem): i is Entry => i.op === "market" || i.op === "pending";

/** A stored item as the executor runs it. Entries carry their full broker request, tag included (R9.1). */
export function toExecItem(i: StoredItem): ExecItem {
  if (i.op === "market") {
    const { symbol, side, volume, sl, tp, magic, comment, clientId } = i;
    return { op: "market", req: { symbol, side, volume, sl, tp, magic, comment, clientId } };
  }
  if (i.op === "pending") {
    const { symbol, type, volume, openPrice, sl, tp, magic, comment, clientId } = i;
    return { op: "pending", req: { symbol, type, volume, openPrice, sl, tp, magic, comment, clientId } };
  }
  return i;
}

type Guarded = { ok: true; run: ExecItem[]; skipped: Skipped[] } | { ok: false; refusal: ExecuteRefusal };

/** Fresh quote and spec for a §7 check. The broker may have widened stops since the preview: never a cached spec. */
async function freshMarket(svc: TradingServices, symbol: string) {
  svc.specs.invalidate(symbol);
  const [quote, spec] = await Promise.all([svc.broker.getQuote(symbol), svc.specs.get(symbol)]);
  if (quoteProblems(quote).length > 0) {
    throw new BrokerError("BAD_DATA", `unusable quote for ${symbol}: ${quoteProblems(quote).join(", ")}`);
  }
  return { quote, spec };
}

const STALE: ExecuteRefusal = {
  code: "PRICE_STALE",
  message: "The last price is too old to check against. Nothing was sent.",
};

/**
 * §7 for entries: fresh quote (R7.2), then EVERY entry re-checked against the market now. Any one no longer valid
 * refuses the whole batch with zero broker calls: never half a ladder, never an entry whose stop would be refused.
 */
async function entryGuard(
  svc: TradingServices,
  plan: StoredPlan,
  entries: readonly Entry[],
): Promise<Guarded> {
  const { quote, spec } = await freshMarket(svc, plan.summary.symbol);
  if (svc.clock.now() - quote.time > MAX_QUOTE_AGE_MS) return { ok: false, refusal: STALE };
  // R9.4: the spread NOW, not at preview. Too wide → the whole batch is refused, zero calls.
  svc.spread.record(quote, spec);
  const spread = spreadCheck(svc, quote, spec);
  if (spread.block) {
    return {
      ok: false,
      refusal: { code: "SPREAD_TOO_WIDE", message: spread.reason ?? "Spread too wide. Nothing was sent." },
    };
  }
  const m = marketFrom(spec, quote);
  const moved = entries.flatMap((e) => entryProblems(e, m).map((reason) => ({ id: e.clientId, reason })));
  if (moved.length > 0) {
    return {
      ok: false,
      refusal: {
        code: "PRICE_MOVED",
        message: `Price moved: ${String(new Set(moved.map((x) => x.id)).size)} of ${String(entries.length)} orders are no longer valid. Nothing was sent. Preview again.`,
        details: moved,
      },
    };
  }
  return { ok: true, run: plan.items.map(toExecItem), skipped: [] };
}

/** §7. Returns the items to run, the ones skipped up front (R7.1), or why the plan can't run at all. */
export async function driftGuard(svc: TradingServices, plan: StoredPlan): Promise<Guarded> {
  const entries = plan.items.filter(isEntry);
  if (entries.length > 0) return entryGuard(svc, plan, entries);
  const modifies = plan.items.filter((i): i is Modify => i.op === "modify");
  if (modifies.length === 0) return { ok: true, run: plan.items.map(toExecItem), skipped: [] };
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
  const run = plan.items.filter((item) => {
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
  return { ok: true, run: run.map(toExecItem), skipped };
}

/** Nothing was claimed: the same plan can be executed again in a few seconds, on the new instance. */
export const shuttingDown = {
  ok: false,
  code: "SHUTTING_DOWN",
  message: "The server is restarting. Nothing was sent. Try again in a few seconds.",
} as const;

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
  const drift = await driftGuard(svc, plan);
  if (!drift.ok) return { ok: false, ...drift.refusal };

  let started;
  try {
    started = await svc.runner.start(plan.id, drift.run, { urgent: plan.summary.action === "close" });
  } catch (e) {
    if (e instanceof PlanExpiredError) {
      return { ok: false, code: "PLAN_EXPIRED", message: "This preview expired (30 s). Preview again." };
    }
    throw e;
  }
  if (!started.ok) return started.code === "SHUTTING_DOWN" ? shuttingDown : already();
  await noteSkipped(db, started.executionId, drift.skipped);
  svc.background.track(persistResults(svc.runner, db, started.executionId, record));
  return { ok: true, executionId: started.executionId, skipped: drift.skipped, count: drift.run.length };
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
