/**
 * The batch executor (Phase 04). Runs a plan's broker calls:
 * - in plan order (the plan builder already put the most exposed first: R2.10, R4.6),
 * - through the credit limiter (never over MetaApi's budget) with bounded concurrency,
 * - with the §6 retry policy and the ADR-0009 entry reconciliation protocol (retries.ts),
 * - streaming one event per finished item, then a summary.
 * It never throws: every item ends with an outcome. Abort stops new work; calls already in flight finish.
 */
import type { BrokerProvider, TradeResult } from "@/broker/BrokerProvider";
import { RETCODE } from "@/broker/retcodes";
import { Channel, Deferred } from "./channel";
import type { CircuitBreaker } from "./circuitBreaker";
import type { CreditLimiter, Priority } from "./rateLimiter";
import {
  DEFAULT_RETRY,
  normalisePolicy,
  runItem,
  type CallLog,
  type Revalidate,
  type RetryPolicy,
} from "./retries";
import type { Scheduler } from "./scheduler";
import { targetOf, type ExecEvent, type ExecItem, type ItemResult, type Progress } from "./types";

export interface ExecuteDeps {
  readonly broker: BrokerProvider;
  readonly limiter: CreditLimiter;
  readonly scheduler: Scheduler;
  /** Workers running items at once. The limiter's in-flight cap still applies on top. */
  readonly concurrency: number;
  /** MetaApi credits per trade call (09-PERFORMANCE: 10). */
  readonly costPerTrade?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** R6.3: re-check a modify against fresh state before retrying it. */
  readonly revalidate?: Revalidate;
  readonly signal?: AbortSignal;
  /** One line per broker call, for structured logs and metrics. */
  readonly onCall?: CallLog;
  /** 0..1, for backoff jitter. */
  readonly random?: () => number;
  /** R9.11: a market fill further than this many points from the expected price halts the rest of the batch. */
  readonly maxFillDriftPoints?: number;
  /** "urgent" for close-now: served ahead of everything else in the shared limiter. */
  readonly priority?: Priority;
  /** Shared broker-outage breaker (circuitBreaker.ts). */
  readonly breaker?: CircuitBreaker;
  /**
   * Restart recovery: durably record "about to send item `index`" before its first broker call, so a crash mid-batch
   * can tell "never sent" from "maybe sent". Normal runs wait for it and refuse to send if it fails. Urgent runs
   * (close-now: closes and cancels, safe to resend) never wait on it: bookkeeping must not slow a panic close.
   */
  readonly beforeSend?: (index: number, item: ExecItem) => Promise<void>;
}

/** R9.10 (codes verified in retcodes.ts; 10040 is the account position cap per MetaApi's docs). */
const SYSTEMIC_ENTRY_CODES: ReadonlySet<number> = new Set([
  RETCODE.NO_MONEY,
  RETCODE.LIMIT_ORDERS,
  RETCODE.LIMIT_VOLUME,
  RETCODE.LIMIT_POSITIONS,
  RETCODE.TRADE_DISABLED,
  RETCODE.MARKET_CLOSED,
  // Not in R9.10's list, but every order of the batch carries the same fill modes: one refusal means all of them.
  RETCODE.INVALID_FILL,
]);

export function execute(items: readonly ExecItem[], deps: ExecuteDeps): AsyncIterable<ExecEvent> {
  const channel = new Channel<ExecEvent>();
  // run() handles every item's errors itself; this guard only exists so a bug can never leave a consumer hanging.
  run(items, deps, channel).catch(() => {
    channel.close();
  });
  return channel;
}

async function run(items: readonly ExecItem[], deps: ExecuteDeps, out: Channel<ExecEvent>): Promise<void> {
  const startedAt = deps.scheduler.now();
  const policy: RetryPolicy = normalisePolicy({ ...DEFAULT_RETRY, ...deps.retry });
  const concurrency = Number.isFinite(deps.concurrency) ? Math.max(1, Math.floor(deps.concurrency)) : 1;
  const results: (ItemResult | undefined)[] = new Array<ItemResult | undefined>(items.length).fill(undefined);
  const counts = { finished: 0, done: 0, failed: 0, unknown: 0, skipped: 0 };
  const inBackground: Promise<void>[] = [];
  let retries = 0;
  let next = 0;

  // R9.10: the first systemic entry failure (no money, position/volume limits, trading disabled, market closed) means
  // every later entry would fail the same way and cost 10 credits each: nothing new is sent after it.
  let systemic: string | undefined;

  const progress = (): Progress => ({ total: items.length, ...counts });
  const finish = (r: ItemResult) => {
    if (
      systemic === undefined &&
      r.outcome === "failed" &&
      (r.op === "market" || r.op === "pending") &&
      r.code !== null &&
      SYSTEMIC_ENTRY_CODES.has(r.code)
    ) {
      systemic = r.message || r.stringCode;
    }
    if (
      systemic === undefined &&
      deps.maxFillDriftPoints !== undefined &&
      r.outcome === "done" &&
      r.driftPoints !== undefined &&
      r.driftPoints > deps.maxFillDriftPoints
    ) {
      systemic = `a fill ${String(r.driftPoints)} points from the expected price`;
    }
    results[r.index] = r;
    counts.finished += 1;
    counts[r.outcome] += 1;
    retries += Math.max(0, r.attempts - 1);
    out.push({ type: "item", item: r, progress: progress() });
  };

  // A plan must never touch the same target twice (a double entry, or a false "done" via reconcile): later copies are
  // refused before anything is sent (QA review).
  const firstIndex = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const key = `${item.op === "market" || item.op === "pending" ? "entry" : item.op === "cancel" ? "order" : "position"}:${targetOf(item)}`;
    const first = firstIndex.get(key);
    if (first === undefined) firstIndex.set(key, index);
    else finish(blank(index, item, "skipped", `duplicate of item ${String(first)} in this plan: not sent`));
  }

  const recordIntent = async (index: number, item: ExecItem): Promise<boolean> => {
    const hook = deps.beforeSend;
    if (hook === undefined) return true;
    if (deps.priority === "urgent") {
      hook(index, item).catch(() => undefined);
      return true;
    }
    try {
      await hook(index, item);
      return true;
    } catch (e) {
      finish(
        blank(
          index,
          item,
          "failed",
          `not sent: couldn't record the send first (${e instanceof Error ? e.message : String(e)})`,
        ),
      );
      return false;
    }
  };

  const worker = async () => {
    for (;;) {
      if (deps.signal?.aborted === true) return;
      const index = next;
      const item = items[index];
      if (item === undefined) return;
      next += 1;
      if (results[index] !== undefined) continue;
      if (systemic !== undefined && (item.op === "market" || item.op === "pending")) {
        const rule = systemic.endsWith("expected price") ? "R9.11" : "R9.10";
        finish(
          blank(index, item, "skipped", `not sent: ${systemic} stopped the rest of the batch (${rule})`),
        );
        continue;
      }
      if (!(await recordIntent(index, item))) continue;
      // An item that has to wait on a slow/stuck request frees its worker (SRE review: otherwise a hung broker stalls
      // close-now for an hour). It finishes in the background; the run waits for it before completing.
      const freed = new Deferred();
      const done = runItem(index, item, {
        ...deps,
        policy,
        random: deps.random ?? Math.random,
        yieldWorker: () => {
          freed.resolve();
        },
      }).then(finish, (e: unknown) => {
        // Defence in depth: runItem shouldn't throw. If it does, the outcome is unknown, never "done".
        finish(
          blank(index, item, "unknown", `executor error: ${e instanceof Error ? e.message : String(e)}`),
        );
      });
      inBackground.push(done);
      await Promise.race([done, freed.promise]);
    }
  };

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  await Promise.all(inBackground);

  // Anything never started (abort) is reported, so the counts always add up to the total.
  for (const [index, item] of items.entries()) {
    if (results[index] === undefined) finish(blank(index, item, "skipped", "aborted before it was sent"));
  }

  out.push({
    type: "complete",
    summary: {
      ...progress(),
      startedAt,
      finishedAt: deps.scheduler.now(),
      retries,
      aborted: deps.signal?.aborted === true,
    },
  });
  out.close();
}

function blank(index: number, item: ExecItem, outcome: ItemResult["outcome"], message: string): ItemResult {
  return {
    index,
    op: item.op,
    targetId: targetOf(item),
    outcome,
    code: null,
    stringCode: "",
    message,
    attempts: 0,
    latencyMs: 0,
  };
}

/** Send one item to the broker. Exported for the retry layer and tests. */
export function send(broker: BrokerProvider, item: ExecItem): Promise<TradeResult> {
  switch (item.op) {
    case "modify":
      return broker.modifyPosition(item.positionId, { sl: item.sl, tp: item.tp });
    case "close":
      return broker.closePosition(item.positionId);
    case "cancel":
      return broker.cancelOrder(item.orderId);
    case "market":
      return broker.placeMarket(item.req);
    case "pending":
      return broker.placePending(item.req);
  }
}
