/**
 * One item, start to finish: §6 retry policy, R6.3/R7.1/R7.2 re-validation, R6.2 rate-limit pauses, and the ADR-0009
 * protocol for entries whose outcome is unknown. Returns an ItemResult; never throws.
 *
 * Zombie rules (Phase 03/04 reviews):
 * - modify: a timed-out call carries `settled`. Wait for it (bounded, off the worker, counted in flight) before retrying,
 *   so a stale request can't land after a newer one. Never settles → "unknown". A timeout with no `settled` → "unknown".
 * - close/cancel: closing by ticket is idempotent, so don't wait: resend after backoff and let the book check decide.
 * - entries: ADR-0009 (settled, then reconcile; retry only when definitely not placed).
 */
import type { BrokerProvider, TradeResult } from "@/broker/BrokerProvider";
import { LOCAL_CODE, RETCODE, type BrokerOp } from "@/broker/retcodes";
import { send } from "./executor";
import type { CreditLimiter, Priority } from "./rateLimiter";
import { verifyEntryStop } from "./stopCheck";
import type { Scheduler } from "./scheduler";
import { targetOf, type ExecItem, type ItemResult, type Outcome } from "./types";

export interface RetryPolicy {
  /** §6 R6.1 */
  readonly maxAttempts: number;
  /** Backoff base: base × 2^(attempt−1) ± jitter. */
  readonly baseDelayMs: number;
  readonly jitter: number;
  /** How long to wait for a timed-out call's real outcome (ADR-0009). */
  readonly settleTimeoutMs: number;
  /** Reconcile polls for stream lag (at least 1), and the gap between them (ADR-0009). */
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

/** Clamp a policy to sane values: a zero poll count would skip reconciliation entirely (QA review). */
export function normalisePolicy(p: RetryPolicy): RetryPolicy {
  const atLeast = (n: number, min: number, fallback: number) =>
    Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
  return {
    maxAttempts: atLeast(p.maxAttempts, 1, DEFAULT_RETRY.maxAttempts),
    baseDelayMs: atLeast(p.baseDelayMs, 0, DEFAULT_RETRY.baseDelayMs),
    jitter: Number.isFinite(p.jitter) ? Math.min(1, Math.max(0, p.jitter)) : DEFAULT_RETRY.jitter,
    settleTimeoutMs: atLeast(p.settleTimeoutMs, 0, DEFAULT_RETRY.settleTimeoutMs),
    reconcilePolls: atLeast(p.reconcilePolls, 1, DEFAULT_RETRY.reconcilePolls),
    reconcileIntervalMs: atLeast(p.reconcileIntervalMs, 0, DEFAULT_RETRY.reconcileIntervalMs),
  };
}

export type ModifyItem = Extract<ExecItem, { op: "modify" }>;

/**
 * R6.3 / R7.1 / R7.2. `alreadyDone`: the position is already in the wanted state. `skip`: the change no longer applies
 * (e.g. the owner changed a level elsewhere since the preview), so it's reported as skipped, not failed.
 */
export type Revalidate = (
  item: ModifyItem,
) => Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly alreadyDone?: boolean; readonly skip?: boolean }
>;

export type CallLog = (e: {
  /** Set by the runner, so every log line says which execution it belongs to. */
  readonly executionId?: string;
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
  readonly priority?: Priority;
  readonly revalidate?: Revalidate;
  readonly onCall?: CallLog;
  /** Abort / kill switch: checked after waiting for credits and before every retry, not just between items. */
  readonly signal?: AbortSignal;
  /** Called before a long wait (settle, reconcile) so the executor can give this worker to the next item. */
  readonly yieldWorker?: () => void;
}

type Next =
  /** `result` = what drove the retry (a late result may carry its own retry time). */
  | { readonly kind: "retry"; readonly result?: TradeResult }
  | {
      readonly kind: "end";
      readonly outcome: Outcome;
      readonly message: string;
      readonly result?: TradeResult;
      readonly extra?: Partial<ItemResult>;
    };

const reasonOf = (r: TradeResult) => (r.message === "" ? r.stringCode : `${r.stringCode}: ${r.message}`);
const isEntry = (item: ExecItem) => item.op === "market" || item.op === "pending";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wait for a promise, but no longer than ms. null = it didn't settle in time (or broke its never-reject contract). */
async function within<T>(p: Promise<T>, ms: number, s: Scheduler): Promise<T | null> {
  const winner = await Promise.race([
    p.then(
      (value) => ({ value }),
      () => null,
    ),
    s.sleep(ms).then(() => null),
  ]);
  return winner === null ? null : winner.value;
}

/**
 * Wait (bounded) for a timed-out request's real outcome, freeing the worker for the next item meanwhile.
 * (Counting it in flight is done in runItem, before the send's own slot is released.)
 */
async function awaitSettled(settled: Promise<TradeResult>, ctx: RunContext): Promise<TradeResult | null> {
  ctx.yieldWorker?.();
  return within(settled, ctx.policy.settleTimeoutMs, ctx.scheduler);
}

/** Logging must never change a trade's outcome. */
function safely(hook: () => void): void {
  try {
    hook();
  } catch {
    // A broken logger is a logging problem, not a trading one.
  }
}

export async function runItem(index: number, item: ExecItem, ctx: RunContext): Promise<ItemResult> {
  const targetId = targetOf(item);
  let attempts = 0;
  let latencyMs = 0;

  const base = (outcome: Outcome, message: string): ItemResult => ({
    index,
    op: item.op,
    targetId,
    outcome,
    code: null,
    stringCode: "",
    message,
    attempts,
    latencyMs,
  });
  const end = (
    outcome: Outcome,
    message: string,
    r: TradeResult,
    extra: Partial<ItemResult> = {},
  ): ItemResult => ({
    ...base(outcome, message),
    code: r.code,
    stringCode: r.stringCode,
    ...(r.positionId === undefined ? {} : { positionId: r.positionId }),
    ...(r.orderId === undefined ? {} : { orderId: r.orderId }),
    ...extra,
  });
  /** Abort before (another) send. Never sent → skipped; already tried → failed with the last reason. */
  const stopped = (r: TradeResult | undefined): ItemResult =>
    r === undefined
      ? base("skipped", "aborted before it was sent")
      : end("failed", `aborted before retry (last: ${reasonOf(r)})`, r);
  // A function, not an inline check: the signal can flip during any await below.
  const aborted = (): boolean => ctx.signal?.aborted === true;

  let last: TradeResult | undefined;
  for (;;) {
    let release: () => void;
    try {
      release = await ctx.limiter.acquire(ctx.costPerTrade ?? 10, ctx.priority);
    } catch (e) {
      return base("failed", `can't send: ${errText(e)}`);
    }
    if (aborted()) {
      release();
      return stopped(last);
    }
    // R6.3 / R7.1 / R7.2: re-check a retried modify right before it goes out (after the queue wait, not before it).
    if (last !== undefined && item.op === "modify" && ctx.revalidate !== undefined) {
      try {
        const v = await ctx.revalidate(item);
        if (!v.ok) {
          release();
          return end(
            v.alreadyDone === true ? "done" : v.skip === true ? "skipped" : "failed",
            v.reason,
            last,
          );
        }
      } catch (e) {
        release();
        return end("failed", `couldn't re-validate before retry: ${errText(e)}`, last);
      }
    }
    attempts += 1;
    let r: TradeResult;
    let keepSlot = false;
    try {
      r = await send(ctx.broker, item);
      if (r.settled !== undefined) {
        // A request we gave up on may still be live at MetaApi: its in-flight slot stays taken until it settles or
        // the window passes, so the cap reflects what MetaApi really has in flight.
        keepSlot = true;
        void within(r.settled, ctx.policy.settleTimeoutMs, ctx.scheduler).then(release);
      }
    } finally {
      if (!keepSlot) release();
    }
    last = r;
    latencyMs += r.latencyMs;
    // R6.2: a 429 slows everyone, not just this item. Done before logging so a broken logger can't skip it.
    let pause = r.retryAfterMs === undefined ? 0 : ctx.limiter.pauseFor(r.retryAfterMs);
    safely(() => ctx.onCall?.({ index, op: item.op, targetId, attempt: attempts, result: r }));

    const next = await decide(item, r, attempts, ctx);
    if (next.kind === "end") {
      const finished = end(next.outcome, next.message, next.result ?? r, next.extra);
      // R5.3b: an entry is "done" only once its stop is verified (repaired, or the entry reverted).
      return finished.outcome === "done" && (item.op === "market" || item.op === "pending")
        ? verifyEntryStop(item, finished, ctx)
        : finished;
    }
    if (next.result?.retryAfterMs !== undefined) {
      pause = Math.max(pause, ctx.limiter.pauseFor(next.result.retryAfterMs));
    }
    // Retry: back off, never sooner than the (capped) server retry time.
    const backoff =
      ctx.policy.baseDelayMs * 2 ** (attempts - 1) * (1 + ctx.policy.jitter * (2 * ctx.random() - 1));
    await ctx.scheduler.sleep(Math.max(backoff, pause));
    if (aborted()) return stopped(r);
  }
}

async function decide(item: ExecItem, r: TradeResult, attempts: number, ctx: RunContext): Promise<Next> {
  const outOfAttempts = attempts >= ctx.policy.maxAttempts;
  switch (r.class) {
    case "success":
      return isEntry(item) && r.code === RETCODE.DONE_PARTIAL
        ? partial(item, r, ctx)
        : { kind: "end", outcome: "done", message: "done" };
    case "final":
      return { kind: "end", outcome: "failed", message: reasonOf(r) };
    case "ambiguous":
      return resolveEntry(item, r, outOfAttempts, ctx);
    case "retryable": {
      if (item.op === "modify") {
        if (r.settled !== undefined) {
          // Don't resend while the first request might still land on top of it.
          const late = await awaitSettled(r.settled, ctx);
          if (late === null) {
            return {
              kind: "end",
              outcome: "unknown",
              message: "no answer and a request may still land: check this position before changing it again",
            };
          }
          if (late.ok) {
            return { kind: "end", outcome: "done", message: "done (confirmed late)", result: late };
          }
          if (late.class === "final") {
            return { kind: "end", outcome: "failed", message: reasonOf(late), result: late };
          }
          return outOfAttempts ? giveUp(attempts, late) : { kind: "retry", result: late };
        }
        if (r.code === LOCAL_CODE.ADAPTER_TIMEOUT) {
          // Timed out with no way to learn the real outcome: a blind resend could land after a newer plan's levels.
          return {
            kind: "end",
            outcome: "unknown",
            message: "timed out with no confirmation: check this position before changing it again",
          };
        }
      }
      // close/cancel by ticket are idempotent: no settle wait, the next attempt (and the book check) decides.
      return outOfAttempts ? giveUp(attempts, r) : { kind: "retry" };
    }
  }
}

function giveUp(attempts: number, r: TradeResult): Next {
  return {
    kind: "end",
    outcome: "failed",
    message: `gave up after ${String(attempts)} attempts: ${reasonOf(r)}`,
    result: r,
  };
}

/** R6.7: report what actually filled. */
async function partial(item: ExecItem, r: TradeResult, ctx: RunContext): Promise<Next> {
  const requested = item.op === "market" || item.op === "pending" ? item.req.volume : 0;
  let filled: number | undefined;
  try {
    filled = (await ctx.broker.getPositions()).find((p) => p.id === r.positionId)?.volume;
  } catch {
    filled = undefined;
  }
  return {
    kind: "end",
    outcome: "done",
    message:
      filled === undefined
        ? "partially filled (R6.7), volume unknown: check"
        : `partially filled (R6.7): ${String(filled)} of ${String(requested)} lots`,
    extra: { partial: true, ...(filled === undefined ? {} : { filledVolume: filled }) },
  };
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

  ctx.yieldWorker?.();
  if (r.settled !== undefined) {
    const late = await awaitSettled(r.settled, ctx);
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
        message: `couldn't check whether it was placed (${errText(e)}): check manually`,
      };
    }
    lastStatus = found?.status ?? "notFound";
    if (found?.status === "position" || found?.status === "order") {
      const ids = found.status === "position" ? found.positionIds : found.orderIds;
      if (ids.length > 1) {
        // Worst thing to hide: a double entry. Never report it as a clean "done".
        return {
          kind: "end",
          outcome: "unknown",
          message: `duplicate ${found.status}s for one entry (${ids.join(", ")}): check manually`,
        };
      }
      const ticket = found.status === "position" ? { positionId: ids[0] } : { orderId: ids[0] };
      return {
        kind: "end",
        outcome: "done",
        message: "placed (confirmed by reconcile)",
        result: { ...r, ...ticket },
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
