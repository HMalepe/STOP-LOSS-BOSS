/**
 * The batch executor (Phase 04). Runs a plan's broker calls:
 * - in plan order (the plan builder already put the most exposed first: R2.10, R4.6),
 * - through the credit limiter (never over MetaApi's budget) with bounded concurrency,
 * - with the §6 retry policy and the ADR-0009 entry reconciliation protocol (retries.ts),
 * - streaming one event per finished item, then a summary.
 * It never throws: every item ends with an outcome. Abort stops new work; calls already in flight finish.
 */
import type { BrokerProvider, TradeResult } from "@/broker/BrokerProvider";
import { Channel } from "./channel";
import type { CreditLimiter } from "./rateLimiter";
import { DEFAULT_RETRY, runItem, type CallLog, type Revalidate, type RetryPolicy } from "./retries";
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
}

export function execute(items: readonly ExecItem[], deps: ExecuteDeps): AsyncIterable<ExecEvent> {
  const channel = new Channel<ExecEvent>();
  void run(items, deps, channel);
  return channel;
}

async function run(items: readonly ExecItem[], deps: ExecuteDeps, out: Channel<ExecEvent>): Promise<void> {
  const startedAt = deps.scheduler.now();
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...deps.retry };
  const results: (ItemResult | undefined)[] = new Array<ItemResult | undefined>(items.length).fill(undefined);
  const counts = { finished: 0, done: 0, failed: 0, unknown: 0, skipped: 0 };
  let retries = 0;
  let next = 0;

  const progress = (): Progress => ({ total: items.length, ...counts });
  const finish = (r: ItemResult) => {
    results[r.index] = r;
    counts.finished += 1;
    counts[r.outcome] += 1;
    retries += Math.max(0, r.attempts - 1);
    out.push({ type: "item", item: r, progress: progress() });
  };

  const worker = async () => {
    for (;;) {
      if (deps.signal?.aborted === true) return;
      const index = next;
      const item = items[index];
      if (item === undefined) return;
      next += 1;
      try {
        finish(await runItem(index, item, { ...deps, policy, random: deps.random ?? Math.random }));
      } catch (e) {
        // Defence in depth: runItem shouldn't throw. If it does, the outcome is unknown, never "done".
        finish(
          blank(index, item, "unknown", `executor error: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
  };

  const workers = Math.max(1, Math.min(deps.concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));

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
    items: results.filter((r): r is ItemResult => r !== undefined),
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
