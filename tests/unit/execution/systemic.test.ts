/** R9.10: a refusal that will repeat for every remaining entry stops the batch. */
import { describe, expect, it, vi } from "vitest";
import type { TradeResult } from "@/broker/BrokerProvider";
import { MockBroker } from "@/broker/MockBroker";
import { RETCODE } from "@/broker/retcodes";
import { execute } from "@/execution/executor";
import { CreditLimiter } from "@/execution/rateLimiter";
import { VirtualScheduler } from "@/execution/scheduler";
import { resultsOf, type ExecEvent, type ExecItem } from "@/execution/types";
import type { SymbolSpec } from "@/domain/types";

const SPEC: SymbolSpec = {
  symbol: "EURUSD",
  digits: 5,
  point: 0.00001,
  tickSize: 0.00001,
  stopsLevel: 10,
  freezeLevel: 0,
  volumeMin: 0.01,
  volumeMax: 50,
  volumeStep: 0.01,
};
const refusal = (code: number, name: string): TradeResult => ({
  op: "market",
  ok: false,
  class: "final",
  code,
  stringCode: name,
  message: "",
  latencyMs: 1,
});
const items = (n: number): ExecItem[] =>
  Array.from({ length: n }, (_, i) => ({
    op: "market",
    req: {
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      sl: 1.0845,
      tp: null,
      magic: 1,
      comment: "OD:t",
      clientId: `c${String(i)}`,
    },
  }));

async function run(n: number, answer: (call: number) => TradeResult | undefined, concurrency = 1) {
  const s = new VirtualScheduler(1_763_769_600_000);
  const broker = new MockBroker({
    clock: s,
    sleep: (ms) => s.sleep(ms),
    symbols: [{ spec: SPEC, bid: 1.086, ask: 1.0861, tickValue: 1, contractSize: 100_000 }],
    rateLimit: null,
    latency: { p50: 50, p99: 100 },
    seed: 5,
  });
  const real = broker.placeMarket.bind(broker);
  let call = 0;
  vi.spyOn(broker, "placeMarket").mockImplementation((req) => {
    const forced = answer(call++);
    return forced === undefined ? real(req) : Promise.resolve(forced);
  });
  const limiter = new CreditLimiter({ capacity: 5000, windowMs: 10_000, maxInFlight: 8, scheduler: s });
  const events: ExecEvent[] = [];
  await s.run(
    (async () => {
      for await (const e of execute(items(n), {
        broker,
        limiter,
        scheduler: s,
        concurrency,
        random: () => 0.5,
      })) {
        events.push(e);
      }
    })(),
  );
  const complete = events.find((e) => e.type === "complete");
  return {
    results: resultsOf(events),
    summary: complete?.type === "complete" ? complete.summary : undefined,
    sent: call,
  };
}

describe("R9.10 systemic failures stop the batch", () => {
  it.each([
    [RETCODE.NO_MONEY, "TRADE_RETCODE_NO_MONEY"],
    [RETCODE.LIMIT_ORDERS, "TRADE_RETCODE_LIMIT_ORDERS"],
    [RETCODE.LIMIT_POSITIONS, "TRADE_RETCODE_LIMIT_POSITIONS"],
    [RETCODE.TRADE_DISABLED, "TRADE_RETCODE_TRADE_DISABLED"],
    [RETCODE.MARKET_CLOSED, "TRADE_RETCODE_MARKET_CLOSED"],
  ])("%s on the first entry: nothing else is sent, the rest says why", async (code, name) => {
    const { results, summary, sent } = await run(6, (i) => (i === 0 ? refusal(code, name) : undefined));
    expect(sent).toBe(1);
    expect(results[0]).toMatchObject({ outcome: "failed", code });
    for (const r of results.slice(1)) {
      expect(r).toMatchObject({ outcome: "skipped", attempts: 0 });
      expect(r.message).toBe(`not sent: the batch stopped after ${name} (it would fail the same way)`);
    }
    expect(summary).toMatchObject({ haltedBy: name, total: 6, skipped: 5, failed: 1 });
  });

  it("an ordinary per-entry refusal (invalid stops) does NOT stop the batch", async () => {
    const { results, summary, sent } = await run(4, (i) =>
      i === 1 ? refusal(RETCODE.INVALID_STOPS, "TRADE_RETCODE_INVALID_STOPS") : undefined,
    );
    expect(sent).toBe(4);
    expect(results.map((r) => r.outcome)).toEqual(["done", "failed", "done", "done"]);
    expect(summary?.haltedBy).toBeUndefined();
  });

  it("with concurrency, requests already in flight finish; nothing new starts after the refusal", async () => {
    const { results, sent } = await run(
      10,
      (i) => (i === 0 ? refusal(RETCODE.NO_MONEY, "TRADE_RETCODE_NO_MONEY") : undefined),
      3,
    );
    expect(sent).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.outcome === "skipped").length).toBe(10 - sent);
    expect(results.every((r) => r.outcome !== "unknown")).toBe(true);
  });
});
