import { describe, expect, it, vi } from "vitest";
import type { TradeResult } from "@/broker/BrokerProvider";
import { LOCAL_CODE, RETCODE } from "@/broker/retcodes";
import { CircuitBreaker, isConnectionFailure } from "@/execution/circuitBreaker";
import { ManualClock } from "@/domain/clock";

const result = (code: number): TradeResult =>
  ({ code, stringCode: String(code), message: "", class: "final", latencyMs: 1 }) as TradeResult;
const down = result(LOCAL_CODE.NOT_CONNECTED);
const answered = result(RETCODE.INVALID_STOPS);

function setup(probe: () => Promise<boolean> = () => Promise.resolve(true)) {
  const s = new ManualClock(0);
  const probeFn = vi.fn(probe);
  const b = new CircuitBreaker({ threshold: 3, cooldownMs: 5_000, clock: s, probe: probeFn });
  return { s, b, probe: probeFn };
}

describe("what counts as the broker being unreachable", () => {
  it("not connected, adapter timeout, MT5 timeout/connection; any real answer (even a refusal) does not", () => {
    for (const c of [
      LOCAL_CODE.NOT_CONNECTED,
      LOCAL_CODE.ADAPTER_TIMEOUT,
      RETCODE.TIMEOUT,
      RETCODE.CONNECTION,
    ]) {
      expect(isConnectionFailure(result(c))).toBe(true);
    }
    for (const c of [
      RETCODE.DONE,
      RETCODE.INVALID_STOPS,
      RETCODE.REQUOTE,
      LOCAL_CODE.RATE_LIMITED,
      LOCAL_CODE.UNKNOWN_ERROR,
    ]) {
      expect(isConnectionFailure(result(c))).toBe(false);
    }
  });
});

describe("circuit breaker", () => {
  it("opens after K consecutive connection failures; any answer in between resets the count", async () => {
    const { b } = setup();
    b.record(down);
    b.record(down);
    b.record(answered);
    b.record(down);
    b.record(down);
    expect(b.state).toBe("closed");
    expect(await b.allow()).toBe(true);
    b.record(down);
    expect(b.state).toBe("open");
    expect(await b.allow()).toBe(false);
  });

  it("open: no probe before the cooldown; after it, one health probe decides", async () => {
    const { s, b, probe } = setup();
    for (let i = 0; i < 3; i++) b.record(down);
    s.advance(4_999);
    expect(await b.allow()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    s.advance(1);
    expect(await b.allow()).toBe(true);
    expect(b.state).toBe("halfOpen");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("half-open: one more failure re-opens at once (fresh cooldown); one answer closes", async () => {
    const { s, b } = setup();
    for (let i = 0; i < 3; i++) b.record(down);
    s.advance(5_000);
    await b.allow();
    b.record(down);
    expect(b.state).toBe("open");
    expect(await b.allow()).toBe(false);
    s.advance(5_000);
    await b.allow();
    b.record(answered);
    expect(b.state).toBe("closed");
    b.record(down);
    b.record(down);
    expect(b.state).toBe("closed");
  });

  it("a failed or throwing probe keeps it open and restarts the cooldown", async () => {
    let healthy: boolean | "throw" = false;
    const { s, b, probe } = setup(() =>
      healthy === "throw" ? Promise.reject(new Error("x")) : Promise.resolve(healthy),
    );
    for (let i = 0; i < 3; i++) b.record(down);
    s.advance(5_000);
    expect(await b.allow()).toBe(false);
    expect(await b.allow()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    healthy = "throw";
    s.advance(5_000);
    expect(await b.allow()).toBe(false);
    healthy = true;
    s.advance(5_000);
    expect(await b.allow()).toBe(true);
  });

  it("many items asking at once share one probe", async () => {
    const { s, b, probe } = setup();
    for (let i = 0; i < 3; i++) b.record(down);
    s.advance(5_000);
    expect(await Promise.all([b.allow(), b.allow(), b.allow()])).toEqual([true, true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("explains itself for the item message", () => {
    const { b } = setup();
    for (let i = 0; i < 3; i++) b.record(down);
    expect(b.reason()).toBe("broker unavailable (3 connection failures in a row)");
  });
});

describe("state changes are reported (observability)", () => {
  it("onChange fires once per transition, never for a repeat, and a throwing listener can't break it", async () => {
    const s = new ManualClock(0);
    const seen: string[] = [];
    const b = new CircuitBreaker({
      threshold: 2,
      cooldownMs: 10,
      clock: s,
      probe: () => Promise.resolve(true),
      onChange: (state) => {
        seen.push(state);
        throw new Error("listener bug");
      },
    });
    b.record(answered);
    b.record(down);
    b.record(down);
    b.record(down);
    s.advance(10);
    await b.allow();
    b.record(answered);
    expect(seen).toEqual(["open", "halfOpen", "closed"]);
  });
});
