/**
 * One item, start to finish: §6 retry policy, R6.3 re-validation, R6.2 rate-limit pauses, and the ADR-0009 protocol for
 * entries whose outcome is unknown. Returns an ItemResult; never throws for broker reasons.
 *
 * Zombie rule (Phase 03 SRE review): a call that timed out on our side carries `settled`. We wait for it (bounded) before
 * retrying or finishing, so a stale request can't land after we've moved on. If it still hasn't settled, the item is
 * "unknown": a request may still land, so nobody should assume anything about that position.
 */
import type { BrokerProvider, TradeResult } from "@/broker/BrokerProvider";
import { RETCODE, type BrokerOp } from "@/broker/retcodes";
import type { CreditLimiter } from "./rateLimiter";
import type { Scheduler } from "./scheduler";
import { targetOf, type ExecItem, type ItemResult, type Outcome } from "./types";
import { send } from "./executor";

export interface RetryPolicy {
  /** §6 R6.1 */
  readonly maxAttempts: number;
  /** Backoff base: base × 2^(attempt−1) ± jitter. */
  readonly baseDelayMs: number;
  readonly jitter: number;
  /** How long to wait for a timed-out call's real outcome (ADR-0009). */
  readonly settleTimeoutMs: number;
  /** Reconcile polls for stream lag, and the gap between them (ADR-0009). */
  readonly reconcilePolls: number;
  readonly reconcileIntervalMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 150,
  jitter: 0.3,
  settleTimeoutMs: 60_000,
  reconcilePolls: 5,
  reconcileIntervalMs: 1_000,
};

export type ModifyItem = Extract<ExecItem, { op: "modify" }>;

/** R6.3. `alreadyDone` = the position is already in the wanted state (e.g. closed, for a close). */
export type Revalidate = (
  item: ModifyItem,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly alreadyDone?: boolean }
>;

export type CallLog = (e: {
  readonly index: number;
  readonly op: BrokerOp;
  readonly targetId: string;
  readonly attempt: number;
  readonly result: TradeResult;
}) => void;

export interface RunContext {
  readonly broker: BrokerProvider;
  readonly limiter: CreditLimiter;
  readonly scheduler: Scheduler;
  readonly policy: RetryPolicy;
  readonly random: () => number;
  readonly costPerTrade?: number;
  readonly revalidate?: Revalidate;
  readonly onCall?: CallLog;
}

type Next =
  | { readonly kind: "retry" }
  | {
      readonly kind: "end";
      readonly outcome: Outcome;
      readonly message: string;
      readonly result?: TradeResult;
    };

const reasonOf = (r: TradeResult) => (r.message === "" ? r.stringCode : `${r.stringCode}: ${r.message}`);
const isEntry = (item: ExecItem) => item.op === "market" || item.op === "pending";

/** Wait for a promise, but no longer than ms. null = it didn't settle in time. */
async function within<T>(p: Promise<T>, ms: number, s: Scheduler): Promise<T | null> {
  const winner = await Promise.race([p.then((value) => ({ value })), s.sleep(ms).then(() => null)]);
  return winner === null ? null : winner.value;
}

export async function runItem(index: number, item: ExecItem, ctx: RunContext): Promise<ItemResult> {
  const targetId = targetOf(item);
  let attempts = 0;
  let latencyMs = 0;

  const end = (outcome: Outcome, message: string, r: TradeResult): ItemResult => ({
    index,
    op: item.op,
    targetId,
    outcome,
    code: r.code,
    stringCode: r.stringCode,
    message,
    attempts,
    latencyMs,
    ...(r.positionId === undefined ? {} : { positionId: r.positionId }),
    ...(r.orderId === undefined ? {} : { orderId: r.orderId }),
    ...(outcome === "done" && isEntry(item) && r.code === RETCODE.DONE_PARTIAL ? { partial: true } : {}),
  });

  for (;;) {
    const release = await ctx.limiter.acquire(ctx.costPerTrade ?? 10);
    attempts += 1;
    let r: TradeResult;
    try {
      r = await send(ctx.broker, item);
    } finally {
      release();
    }
    latencyMs += r.latencyMs;
    ctx.onCall?.({ index, op: item.op, targetId, attempt: attempts, result: r });
    // R6.2: a 429 slows everyone, not just this item.
    if (r.retryAfterMs !== undefined) ctx.limiter.pauseFor(r.retryAfterMs);

    const next = await decide(item, r, attempts, ctx);
    if (next.kind === "end") return end(next.outcome, next.message, next.result ?? r);
    // Retry: back off (and never sooner than the server asked).
    const backoff =
      ctx.policy.baseDelayMs * 2 ** (attempts - 1) * (1 + ctx.policy.jitter * (2 * ctx.random() - 1));
    await ctx.scheduler.sleep(Math.max(backoff, r.retryAfterMs ?? 0));

    // R6.3: before re-sending a modify, make sure it's still valid against fresh state.
    if (item.op === "modify" && ctx.revalidate !== undefined) {
      try {
        const v = await ctx.revalidate(item);
        if (!v.ok) return end(v.alreadyDone === true ? "done" : "failed", v.reason, r);
      } catch (e) {
        return end(
          "failed",
          `couldn't re-validate before retry: ${e instanceof Error ? e.message : String(e)}`,
          r,
        );
      }
    }
  }
}

async function decide(item: ExecItem, r: TradeResult, attempts: number, ctx: RunContext): Promise<Next> {
  const outOfAttempts = attempts >= ctx.policy.maxAttempts;
  switch (r.class) {
    case "success":
      return {
        kind: "end",
        outcome: "done",
        message: isEntry(item) && r.code === RETCODE.DONE_PARTIAL ? "partially filled (R6.7)" : "done",
      };
    case "final":
      return { kind: "end", outcome: "failed", message: reasonOf(r) };
    case "ambiguous":
      return resolveEntry(item, r, outOfAttempts, ctx);
    case "retryable": {
      if (r.settled !== undefined) {
        // Zombie rule: don't move on while the first request might still land.
        const late = await within(r.settled, ctx.policy.settleTimeoutMs, ctx.scheduler);
        if (late === null) {
          return {
            kind: "end",
            outcome: "unknown",
            message: "no answer and a request may still land: check this position before changing it again",
          };
        }
        if (late.ok) return { kind: "end", outcome: "done", message: "done (confirmed late)", result: late };
        if (late.class === "final") {
          return { kind: "end", outcome: "failed", message: reasonOf(late), result: late };
        }
      }
      if (outOfAttempts) {
        return {
          kind: "end",
          outcome: "failed",
          message: `gave up after ${String(attempts)} attempts: ${reasonOf(r)}`,
        };
      }
      return { kind: "retry" };
    }
  }
}

/** ADR-0009: an entry whose outcome is unknown. Retry only when we KNOW the first attempt didn't land. */
async function resolveEntry(
  item: ExecItem,
  r: TradeResult,
  outOfAttempts: boolean,
  ctx: RunContext,
): Promise<Next> {
  const clientId = targetOf(item);
  let definitelyNotPlaced = false;

  if (r.settled !== undefined) {
    const late = await within(r.settled, ctx.policy.settleTimeoutMs, ctx.scheduler);
    if (late?.ok === true) {
      return { kind: "end", outcome: "done", message: "done (confirmed late)", result: late };
    }
    if (late?.class === "final") {
      return { kind: "end", outcome: "failed", message: reasonOf(late), result: late };
    }
    definitelyNotPlaced = late?.class === "retryable";
  }

  let lastStatus = "notFound";
  for (let poll = 0; poll < ctx.policy.reconcilePolls; poll++) {
    if (poll > 0) await ctx.scheduler.sleep(ctx.policy.reconcileIntervalMs);
    let found;
    try {
      found = (await ctx.broker.reconcile([clientId])).get(clientId);
    } catch (e) {
      return {
        kind: "end",
        outcome: "unknown",
        message: `couldn't check whether it was placed (${e instanceof Error ? e.message : String(e)}): check manually`,
      };
    }
    lastStatus = found?.status ?? "notFound";
    if (found?.status === "position") {
      return {
        kind: "end",
        outcome: "done",
        message: "placed (confirmed by reconcile)",
        result: { ...r, positionId: found.positionIds[0] },
      };
    }
    if (found?.status === "order") {
      return {
        kind: "end",
        outcome: "done",
        message: "placed (confirmed by reconcile)",
        result: { ...r, orderId: found.orderIds[0] },
      };
    }
  }

  if (lastStatus === "inFlight") {
    return {
      kind: "end",
      outcome: "unknown",
      message: "still being processed by the broker: check manually",
    };
  }
  if (definitelyNotPlaced && !outOfAttempts) return { kind: "retry" };
  if (definitelyNotPlaced) {
    return { kind: "end", outcome: "failed", message: `not placed after retries: ${reasonOf(r)}` };
  }
  return {
    kind: "end",
    outcome: "unknown",
    message: "may have been placed, not found yet: check manually (never retried, ADR-0009)",
  };
}
