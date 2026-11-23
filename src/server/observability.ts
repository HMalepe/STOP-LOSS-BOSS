/**
 * Observability (Phase 03/04 SRE carry-over). Everything the operator of a real-money tool must hear about, with no
 * vendor attached: structured log lines plus in-process counters.
 *
 * Alerts are `error` lines carrying an `alert` field. Hosts alert on log lines (docs/08), so this works on Fly or
 * Railway today and can be pointed at a paging service later without touching trading code.
 *
 * | alert            | when                                                                         |
 * |------------------|------------------------------------------------------------------------------|
 * | unknown_outcome  | an item ended "may or may not have happened": check MT5 now                  |
 * | failure_rate     | ≥ 20% of a batch of ≥ 5 failed                                               |
 * | execution_slow   | a batch took > 60 s (close-now > 30 s)                                       |
 * | breaker_open     | the broker stopped answering (circuit breaker opened)                        |
 * | interrupted      | runs cut off by a restart or a shutdown that couldn't drain                  |
 *
 * Never throws: a broken logger is a logging problem, not a trading one.
 */
import type { BrokerOp } from "@/broker/retcodes";
import type { TradeResult } from "@/broker/BrokerProvider";
import { isConnectionFailure, type BreakerState } from "@/execution/circuitBreaker";
import type { ItemResult, Summary } from "@/execution/types";

export interface ObsLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface CallEvent {
  readonly executionId?: string;
  readonly index: number;
  readonly op: BrokerOp;
  readonly targetId: string;
  readonly attempt: number;
  readonly result: TradeResult;
}

export const SLOW_MS = { normal: 60_000, urgent: 30_000 } as const;
const FAILURE_RATE = { min: 5, ratio: 0.2 } as const;

export interface ObsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly breaker: BreakerState;
}

export class Observability {
  readonly #log: ObsLogger;
  readonly #counters = new Map<string, number>();
  #breaker: BreakerState = "closed";

  constructor(log: ObsLogger) {
    this.#log = log;
  }

  call(e: CallEvent): void {
    this.#count("broker_calls");
    const line = {
      ...(e.executionId === undefined ? {} : { executionId: e.executionId }),
      index: e.index,
      op: e.op,
      targetId: e.targetId,
      attempt: e.attempt,
      code: e.result.code,
      stringCode: e.result.stringCode,
      latencyMs: Math.round(e.result.latencyMs),
    };
    if (isConnectionFailure(e.result)) {
      this.#count("broker_connection_failures");
      this.#safe(() => {
        this.#log.warn(line, "broker call: no connection");
      });
    } else {
      this.#safe(() => {
        this.#log.info(line, "broker call");
      });
    }
  }

  item(executionId: string, r: ItemResult): void {
    this.#count(`items_${r.outcome}`);
    if (r.outcome === "unknown") {
      this.#alert(
        "unknown_outcome",
        { executionId, index: r.index, op: r.op, targetId: r.targetId, message: r.message },
        "an order may or may not have happened: check it in MT5",
      );
    }
  }

  complete(executionId: string, s: Summary, urgent: boolean): void {
    this.#count("executions_complete");
    const ms = s.finishedAt - s.startedAt;
    const counts = {
      executionId,
      total: s.total,
      done: s.done,
      failed: s.failed,
      unknown: s.unknown,
      skipped: s.skipped,
      ms,
      urgent,
    };
    this.#safe(() => {
      this.#log.info(counts, "execution complete");
    });
    if (s.total >= FAILURE_RATE.min && s.failed / s.total >= FAILURE_RATE.ratio) {
      this.#alert("failure_rate", counts, `${String(s.failed)} of ${String(s.total)} failed`);
    }
    if (ms > (urgent ? SLOW_MS.urgent : SLOW_MS.normal)) {
      this.#alert("execution_slow", counts, `batch took ${String(Math.round(ms / 1000))} s`);
    }
  }

  breaker(state: BreakerState, reason: string): void {
    this.#breaker = state;
    if (state === "open") {
      this.#count("breaker_opened");
      this.#alert("breaker_open", { reason }, "broker unavailable: batches fail fast until it's back");
    } else {
      this.#safe(() => {
        this.#log.info({ state }, "circuit breaker");
      });
    }
  }

  interrupted(executionIds: readonly string[], cause: string): void {
    if (executionIds.length === 0) return;
    this.#count("executions_interrupted", executionIds.length);
    this.#alert("interrupted", { executionIds, cause }, "runs cut off: check their unknown items in MT5");
  }

  snapshot(): ObsSnapshot {
    return { counters: Object.fromEntries(this.#counters), breaker: this.#breaker };
  }

  #count(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  #alert(alert: string, details: object, msg: string): void {
    this.#safe(() => {
      this.#log.error({ alert, ...details }, msg);
    });
  }

  #safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // see the module comment
    }
  }
}
