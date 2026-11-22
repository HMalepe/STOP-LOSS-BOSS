/**
 * `pnpm load` (06-TESTING "Load"): 1,000-item batches on MockBroker with realistic latency (p50 120 ms, p99 900 ms), 5% retryable
 * errors and MetaApi's real credit limit, on virtual time. Prints the report and fails if any hard rule breaks:
 * zero duplicates, no item over 3 attempts, the broker never rate-limits us (our limiter keeps under), timing within budget.
 */
import { describe, expect, it } from "vitest";
import { MockBroker } from "@/broker/MockBroker";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { buildPlan } from "@/domain/plan";
import type { SymbolSpec } from "@/domain/types";
import { execute } from "@/execution/executor";
import { CreditLimiter } from "@/execution/rateLimiter";
import { VirtualScheduler } from "@/execution/scheduler";
import type { ExecEvent, ExecItem, ItemResult, Summary } from "@/execution/types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 0,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 200,
  volumeStep: 0.01,
};
/** MetaApi per-account limit (09-PERFORMANCE): 5,000 credits / 10 s, 10 per trade. */
const METAAPI = { capacity: 5_000, windowMs: 10_000, costPerTrade: 10 } as const;

function world(seed: number, extra: Partial<ConstructorParameters<typeof MockBroker>[0]> = {}) {
  const s = new VirtualScheduler(0);
  const broker = new MockBroker({
    clock: s,
    sleep: (ms) => s.sleep(ms),
    seed,
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    latency: { p50: 120, p99: 900 },
    rateLimit: METAAPI,
    account: { balance: 50_000_000, currency: "USD", leverage: 500, marginMode: "HEDGING" },
    ...extra,
  });
  const limiter = new CreditLimiter({
    capacity: METAAPI.capacity,
    windowMs: METAAPI.windowMs,
    maxInFlight: 16,
    scheduler: s,
  });
  return { s, broker, limiter };
}

async function run(items: readonly ExecItem[], w: ReturnType<typeof world>) {
  const events = await w.s.run(
    (async () => {
      const out: ExecEvent[] = [];
      for await (const e of execute(items, {
        broker: w.broker,
        limiter: w.limiter,
        scheduler: w.s,
        concurrency: 16,
        random: () => 0.5,
      })) {
        out.push(e);
      }
      return out;
    })(),
  );
  const last = events.at(-1);
  if (last?.type !== "complete") throw new Error("no summary");
  return { summary: last.summary, results: last.items };
}

const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

function report(
  name: string,
  w: ReturnType<typeof world>,
  summary: Summary,
  results: readonly ItemResult[],
  duplicates: number,
) {
  const lat = w.broker.calls.map((c) => c.result.latencyMs);
  const seconds = (summary.finishedAt - summary.startedAt) / 1000;
  const throttled = w.broker.calls.filter((c) => c.result.code === LOCAL_CODE.RATE_LIMITED).length;
  const row = {
    scenario: name,
    items: summary.total,
    done: summary.done,
    failed: summary.failed,
    unknown: summary.unknown,
    "total (s)": Number(seconds.toFixed(1)),
    "items/s": Number((summary.total / seconds).toFixed(1)),
    "p50 call (ms)": pct(lat, 50),
    "p95 call (ms)": pct(lat, 95),
    retries: summary.retries,
    "max attempts": Math.max(0, ...results.map((r) => r.attempts)),
    "peak in flight": w.limiter.peakInFlight,
    "429s from broker": throttled,
    duplicates,
  };
  // The report is the point of `pnpm load`.
  process.stdout.write(`\n${JSON.stringify(row, null, 2)}\n`);
  return row;
}

describe("pnpm load", () => {
  it("close-now: 1,000 positions, 5% retryable errors, MetaApi credit limit", async () => {
    const w = world(101, { faults: { close: [{ rate: 0.05, code: RETCODE.REQUOTE }] } });
    const ids = Array.from({ length: 1_000 }, (_, i) =>
      w.broker.seedPosition({
        symbol: "EURUSD",
        side: i % 3 === 0 ? "SELL" : "BUY",
        volume: 0.01,
        openPrice: 1.085,
        sl: null,
        tp: null,
        magic: 0,
      }),
    );
    const items: ExecItem[] = ids.map((positionId) => ({
      op: "close",
      positionId,
      side: "BUY",
      volume: 0.01,
    }));
    const { summary, results } = await run(items, w);
    const closes = new Map<string, number>();
    for (const c of w.broker.calls) {
      if (c.result.code === RETCODE.DONE) closes.set(c.target, (closes.get(c.target) ?? 0) + 1);
    }
    const duplicates = [...closes.values()].filter((n) => n > 1).length;
    const row = report("close-now 1,000", w, summary, results, duplicates);

    expect(row.duplicates).toBe(0);
    expect(row["max attempts"]).toBeLessThanOrEqual(3);
    expect(row["429s from broker"]).toBe(0);
    expect(summary.done).toBe(1_000);
    expect(await w.broker.getPositions()).toHaveLength(0);
    // Credit-bound: 10,000 credits at a 4,500 / 10 s budget ≈ 20-25 s (09-PERFORMANCE: "~10 to 20 s", plus 10% headroom).
    expect(row["total (s)"]).toBeLessThan(30);
  }, 120_000);

  it("bulk SL through the whole pipeline: snapshot → buildPlan → execute, 1,000 positions", async () => {
    const w = world(202, { faults: { modify: [{ rate: 0.05, code: RETCODE.PRICE_CHANGED }] } });
    for (let i = 0; i < 1_000; i++) {
      w.broker.seedPosition({
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.01,
        openPrice: 1.085,
        sl: null,
        tp: 1.09 + (i % 40) / 100_000,
        magic: 0,
      });
    }
    const [positions, orders, spec, quote] = await w.s.run(
      Promise.all([
        w.broker.getPositions(),
        w.broker.getOrders(),
        w.broker.getSymbolSpec("EURUSD"),
        w.broker.getQuote("EURUSD"),
      ]),
    );
    const t0 = performance.now();
    const plan = buildPlan(
      { action: "levels", filter: { symbol: "EURUSD", side: "ALL" }, stopLoss: 1.08 },
      { positions, orders, spec, quote },
    );
    const previewMs = performance.now() - t0;
    if (!plan.ok) throw new Error(plan.error.message);
    const { summary, results } = await run(plan.plan.items, w);
    const row = report("bulk SL 1,000 (end to end)", w, summary, results, 0);
    process.stdout.write(`preview (buildPlan, real CPU time): ${previewMs.toFixed(1)} ms\n`);

    expect(summary.done).toBe(1_000);
    expect(previewMs).toBeLessThan(800); // 09-PERFORMANCE preview budget
    // Every TP survived (R2.7) and every SL landed.
    const after = await w.s.run(w.broker.getPositions());
    expect(after.every((p) => p.sl === 1.08 && p.tp !== null)).toBe(true);
    expect(row["429s from broker"]).toBe(0);
  }, 120_000);

  it("entries: 200 with lost replies (some land late, some never) → zero duplicates", async () => {
    const w = world(303, {
      lostReplyRate: 0.1,
      lostReplyDelayMs: 3_000,
      faults: { market: [{ rate: 0.05, code: RETCODE.REQUOTE }] },
    });
    const items: ExecItem[] = Array.from({ length: 200 }, (_, i) => ({
      op: "market",
      req: {
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.01,
        sl: 1.08,
        tp: null,
        magic: 7731000000001,
        comment: "OD:load",
        clientId: `ld${String(i)}`,
      },
    }));
    const { summary, results } = await run(items, w);
    const positions = await w.s.run(w.broker.getPositions());
    const perClient = new Map<string, number>();
    for (const p of positions) perClient.set(p.clientId ?? "", (perClient.get(p.clientId ?? "") ?? 0) + 1);
    const duplicates = [...perClient.values()].filter((n) => n > 1).length;
    report("entries 200, 10% lost replies", w, summary, results, duplicates);

    expect(duplicates).toBe(0);
    expect(positions.every((p) => p.sl === 1.08)).toBe(true); // no naked entries (R5.3)
    expect(summary.done + summary.unknown + summary.failed).toBe(200);
    expect(results.every((r) => r.attempts <= 3)).toBe(true);
  }, 120_000);
});
