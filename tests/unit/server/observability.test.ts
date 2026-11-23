import { describe, expect, it, vi } from "vitest";
import type { TradeResult } from "@/broker/BrokerProvider";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import type { ItemResult, Summary } from "@/execution/types";
import { Observability, type ObsLogger } from "@/server/observability";

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) satisfies ObsLogger;
const result = (code: number, latencyMs = 120): TradeResult =>
  ({ code, stringCode: String(code), message: "", class: "final", latencyMs }) as TradeResult;
const item = (outcome: ItemResult["outcome"], over: Partial<ItemResult> = {}): ItemResult => ({
  index: 0,
  op: "modify",
  targetId: "p1",
  outcome,
  code: null,
  stringCode: "",
  message: "m",
  attempts: 1,
  latencyMs: 100,
  ...over,
});
const summary = (over: Partial<Summary>): Summary => ({
  total: 10,
  finished: 10,
  done: 10,
  failed: 0,
  unknown: 0,
  skipped: 0,
  startedAt: 0,
  finishedAt: 1_000,
  retries: 0,
  aborted: false,
  ...over,
});
const alerts = (l: ReturnType<typeof log>) =>
  l.error.mock.calls.map((c) => (c[0] as { alert: string }).alert);

describe("observability: what a real-money operator must hear about", () => {
  it("every broker call is a structured line (execution, item, op, code, latency) and counted", () => {
    const l = log();
    const o = new Observability(l);
    o.call({
      executionId: "e1",
      index: 3,
      op: "close",
      targetId: "p9",
      attempt: 2,
      result: result(RETCODE.DONE, 87),
    });
    expect(l.info).toHaveBeenCalledWith(
      {
        executionId: "e1",
        index: 3,
        op: "close",
        targetId: "p9",
        attempt: 2,
        code: RETCODE.DONE,
        stringCode: String(RETCODE.DONE),
        latencyMs: 87,
      },
      "broker call",
    );
    expect(o.snapshot().counters).toMatchObject({ broker_calls: 1 });
  });

  it("connection failures are counted separately and logged as warnings", () => {
    const l = log();
    const o = new Observability(l);
    o.call({
      executionId: "e1",
      index: 0,
      op: "modify",
      targetId: "p",
      attempt: 1,
      result: result(LOCAL_CODE.NOT_CONNECTED),
    });
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(o.snapshot().counters).toMatchObject({ broker_calls: 1, broker_connection_failures: 1 });
  });

  it("ALERT unknown_outcome for every item that may or may not have happened", () => {
    const l = log();
    const o = new Observability(l);
    o.item("e1", item("done"));
    o.item("e1", item("unknown", { targetId: "p7", message: "check MT5" }));
    expect(alerts(l)).toEqual(["unknown_outcome"]);
    expect(l.error.mock.calls[0]?.[0]).toMatchObject({ executionId: "e1", targetId: "p7" });
    expect(o.snapshot().counters).toMatchObject({ items_done: 1, items_unknown: 1 });
  });

  it("ALERT failure_rate when ≥ 20% of a batch of ≥ 5 failed; ALERT execution_slow past the limit (close-now stricter)", () => {
    const l = log();
    const o = new Observability(l);
    o.complete("e1", summary({ failed: 1, done: 9 }), false);
    expect(alerts(l)).toEqual([]);
    o.complete("e2", summary({ failed: 2, done: 8 }), false);
    o.complete("e3", summary({ total: 3, failed: 3, done: 0 }), false);
    expect(alerts(l)).toEqual(["failure_rate"]);
    o.complete("e4", summary({ finishedAt: 60_001 }), false);
    o.complete("e5", summary({ finishedAt: 30_001 }), true);
    o.complete("e6", summary({ finishedAt: 30_001 }), false);
    expect(alerts(l)).toEqual(["failure_rate", "execution_slow", "execution_slow"]);
    expect(o.snapshot().counters).toMatchObject({ executions_complete: 6 });
  });

  it("ALERT breaker_open; closing again is info; ALERT interrupted for runs cut off", () => {
    const l = log();
    const o = new Observability(l);
    o.breaker("open", "broker unavailable (5 connection failures in a row)");
    o.breaker("halfOpen", "");
    o.breaker("closed", "");
    o.interrupted(["e1", "e2"], "boot recovery");
    o.interrupted([], "boot recovery");
    expect(alerts(l)).toEqual(["breaker_open", "interrupted"]);
    expect(o.snapshot()).toMatchObject({
      breaker: "closed",
      counters: { breaker_opened: 1, executions_interrupted: 2 },
    });
  });

  it("a broken logger never breaks trading", () => {
    const boom = () => {
      throw new Error("disk full");
    };
    const o = new Observability({ info: boom, warn: boom, error: boom });
    expect(() => {
      o.item("e", item("unknown"));
      o.call({ index: 0, op: "close", targetId: "p", attempt: 1, result: result(RETCODE.DONE) });
    }).not.toThrow();
  });
});
