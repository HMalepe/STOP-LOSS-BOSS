import { describe, expect, it } from "vitest";
import { classify, codeFromString, codeName, LOCAL_CODE, RETCODE, type BrokerOp } from "@/broker/retcodes";

const ALL_OPS: BrokerOp[] = ["modify", "close", "cancel", "market", "pending"];

describe("§6 classification", () => {
  it.each([0, 10008, 10009, 10010, 10025])(
    "%i is success for every op except a partial close (MetaApi success set)",
    (code) => {
      for (const op of ALL_OPS) {
        if (code === 10010 && op === "close") continue;
        expect(classify(code, op)).toBe("success");
      }
    },
  );

  it.each([
    RETCODE.REQUOTE,
    RETCODE.PRICE_CHANGED,
    RETCODE.PRICE_OFF,
    RETCODE.TOO_MANY_REQUESTS,
    LOCAL_CODE.RATE_LIMITED,
    LOCAL_CODE.NOT_CONNECTED,
  ])("%i is retryable for every op", (code) => {
    for (const op of ALL_OPS) expect(classify(code, op)).toBe("retryable");
  });

  it.each([RETCODE.TIMEOUT, RETCODE.CONNECTION, LOCAL_CODE.ADAPTER_TIMEOUT, LOCAL_CODE.UNKNOWN_ERROR])(
    "R6.5: %i is ambiguous for entries, retryable for modify/close/cancel",
    (code) => {
      expect(classify(code, "market")).toBe("ambiguous");
      expect(classify(code, "pending")).toBe("ambiguous");
      expect(classify(code, "modify")).toBe("retryable");
      expect(classify(code, "close")).toBe("retryable");
      expect(classify(code, "cancel")).toBe("retryable");
    },
  );

  it("a partial close (DONE_PARTIAL) is not done: retryable, so the rest gets closed", () => {
    expect(classify(RETCODE.DONE_PARTIAL, "close")).toBe("retryable");
    expect(classify(RETCODE.DONE_PARTIAL, "market")).toBe("success");
  });

  it("R4.5: POSITION_CLOSED is success for close, final for anything else", () => {
    expect(classify(RETCODE.POSITION_CLOSED, "close")).toBe("success");
    expect(classify(RETCODE.POSITION_CLOSED, "modify")).toBe("final");
  });

  it.each([
    RETCODE.INVALID_VOLUME,
    RETCODE.INVALID_STOPS,
    RETCODE.TRADE_DISABLED,
    RETCODE.MARKET_CLOSED,
    RETCODE.NO_MONEY,
    RETCODE.LIMIT_ORDERS,
    RETCODE.LIMIT_VOLUME,
  ])("%i is final (non-retryable)", (code) => {
    for (const op of ALL_OPS) expect(classify(code, op)).toBe("final");
  });

  it("R6.4: unknown codes are final", () => {
    expect(classify(12345, "modify")).toBe("final");
    expect(classify(-99, "market")).toBe("final");
  });

  it("verified values from the MQL5 table", () => {
    expect(RETCODE).toMatchObject({
      REQUOTE: 10004,
      REJECT: 10006,
      PLACED: 10008,
      DONE: 10009,
      DONE_PARTIAL: 10010,
      TIMEOUT: 10012,
      INVALID_VOLUME: 10014,
      INVALID_STOPS: 10016,
      TRADE_DISABLED: 10017,
      MARKET_CLOSED: 10018,
      NO_MONEY: 10019,
      PRICE_CHANGED: 10020,
      PRICE_OFF: 10021,
      TOO_MANY_REQUESTS: 10024,
      NO_CHANGES: 10025,
      FROZEN: 10029,
      CONNECTION: 10031,
      LIMIT_ORDERS: 10033,
      LIMIT_VOLUME: 10034,
      POSITION_CLOSED: 10036,
    });
  });
});

describe("string codes", () => {
  it("maps MetaApi string codes to numbers", () => {
    expect(codeFromString("ERR_NO_ERROR")).toBe(0);
    expect(codeFromString("TRADE_RETCODE_DONE")).toBe(10009);
    expect(codeFromString("TRADE_RETCODE_INVALID_STOPS")).toBe(10016);
    expect(codeFromString("SOMETHING_ELSE")).toBeNull();
  });

  it("names codes for logs and UI", () => {
    expect(codeName(0)).toBe("ERR_NO_ERROR");
    expect(codeName(10016)).toBe("TRADE_RETCODE_INVALID_STOPS");
    expect(codeName(LOCAL_CODE.ADAPTER_TIMEOUT)).toBe("ADAPTER_TIMEOUT");
    expect(codeName(4242)).toBe("UNKNOWN_4242");
  });
});

describe("close is safe to resend (trading-systems review)", () => {
  it.each([
    RETCODE.REJECT,
    RETCODE.FROZEN,
    RETCODE.LOCKED,
    RETCODE.CLOSE_ORDER_EXIST,
    RETCODE.INVALID,
    RETCODE.ERROR,
  ])("%i is retryable for close but final for modify", (code) => {
    expect(classify(code, "close")).toBe("retryable");
    expect(classify(code, "modify")).toBe("final");
  });

  it("LOCKED on an entry is an unknown outcome", () => {
    expect(classify(RETCODE.LOCKED, "market")).toBe("ambiguous");
    expect(classify(RETCODE.LOCKED, "pending")).toBe("ambiguous");
  });

  it("names the 10038-10046 codes (LIMIT_POSITIONS matters at 1,000+ positions)", () => {
    expect(codeName(10040)).toBe("TRADE_RETCODE_LIMIT_POSITIONS");
    expect(codeName(10039)).toBe("TRADE_RETCODE_CLOSE_ORDER_EXIST");
    expect(codeName(10046)).toBe("TRADE_RETCODE_HEDGE_PROHIBITED");
    expect(classify(RETCODE.LIMIT_POSITIONS, "market")).toBe("final");
  });
});
