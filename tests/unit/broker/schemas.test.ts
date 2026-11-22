import { describe, expect, it } from "vitest";
import { BrokerError } from "@/broker/BrokerProvider";
import {
  metaApiAccount,
  metaApiOrder,
  metaApiPosition,
  metaApiPrice,
  metaApiSpec,
  parseList,
  parseOne,
  toTradeResult,
} from "@/broker/schemas";

/** Shapes copied from the field lists in metaapi.cloud-sdk@29.3.4 (docs/09-PERFORMANCE.md). */
const rawPosition = {
  id: 46214692,
  type: "POSITION_TYPE_BUY",
  symbol: "EURUSD",
  magic: 7731000000042,
  time: new Date("2026-11-21T10:00:00Z"),
  openPrice: 1.085,
  currentPrice: 1.086,
  currentTickValue: 1,
  stopLoss: 1.08,
  takeProfit: 0,
  volume: 0.1,
  swap: -0.3,
  commission: -0.7,
  profit: 9,
  comment: "OD:k3x9",
  clientId: "p7Xa0001",
};

describe("positions", () => {
  it("maps to the domain shape: string id, side, 0 → null level, profit as-is (already net of swap and commission)", () => {
    expect(parseOne(metaApiPosition, rawPosition, "position")).toEqual({
      id: "46214692",
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.1,
      openPrice: 1.085,
      sl: 1.08,
      tp: null,
      profit: 9,
      magic: 7731000000042,
      comment: "OD:k3x9",
    });
  });

  it("absent levels and magic become null and 0; sell maps to SELL", () => {
    const p = parseOne(
      metaApiPosition,
      {
        ...rawPosition,
        type: "POSITION_TYPE_SELL",
        stopLoss: undefined,
        takeProfit: undefined,
        magic: undefined,
        comment: undefined,
      },
      "position",
    );
    expect(p).toMatchObject({ side: "SELL", sl: null, tp: null, magic: 0 });
    expect("comment" in p).toBe(false);
  });

  it("a bad item fails the whole read with its index and field, never a silent drop", () => {
    expect(() =>
      parseList(metaApiPosition, [rawPosition, { ...rawPosition, type: "WEIRD" }], "positions"),
    ).toThrow(/positions\[1\]\.type/);
    expect(() => parseList(metaApiPosition, "nope", "positions")).toThrow(BrokerError);
  });
});

describe("orders", () => {
  const rawOrder = {
    id: 9001,
    type: "ORDER_TYPE_SELL_STOP_LIMIT",
    symbol: "EURUSD",
    openPrice: 1.08,
    volume: 0.2,
    currentVolume: 0.1,
    stopLoss: 0,
  };

  it("maps pending types, prefers currentVolume, 0 SL → null", () => {
    expect(parseOne(metaApiOrder, rawOrder, "order")).toEqual({
      id: "9001",
      symbol: "EURUSD",
      type: "SELL_STOP_LIMIT",
      volume: 0.1,
      openPrice: 1.08,
      sl: null,
      tp: null,
      magic: 0,
    });
  });

  it("falls back to volume when currentVolume is missing", () => {
    expect(parseOne(metaApiOrder, { ...rawOrder, currentVolume: undefined }, "order")?.volume).toBe(0.2);
  });

  it("returns null for orders we don't manage (market in flight, close-by)", () => {
    expect(parseOne(metaApiOrder, { ...rawOrder, type: "ORDER_TYPE_BUY" }, "order")).toBeNull();
    expect(parseOne(metaApiOrder, { ...rawOrder, type: "ORDER_TYPE_CLOSE_BY" }, "order")).toBeNull();
  });
});

describe("spec, price, account", () => {
  const rawSpec = {
    symbol: "EURUSD",
    digits: 5,
    point: 0.00001,
    tickSize: 0.00001,
    stopsLevel: 0,
    freezeLevel: 0,
    minVolume: 0.01,
    maxVolume: 200,
    volumeStep: 0.01,
    contractSize: 100000,
  };

  it("maps spec field names", () => {
    expect(parseOne(metaApiSpec, rawSpec, "spec")).toEqual({
      symbol: "EURUSD",
      digits: 5,
      point: 0.00001,
      tickSize: 0.00001,
      stopsLevel: 0,
      freezeLevel: 0,
      volumeMin: 0.01,
      volumeMax: 200,
      volumeStep: 0.01,
    });
  });

  it("tickSize 0 falls back to point", () => {
    expect(parseOne(metaApiSpec, { ...rawSpec, tickSize: 0 }, "spec").tickSize).toBe(0.00001);
  });

  it("never invents a missing stops level (R0.1)", () => {
    expect(() => parseOne(metaApiSpec, { ...rawSpec, stopsLevel: undefined }, "spec")).toThrow(/stopsLevel/);
  });

  it("price time: Date, ISO string or epoch ms; bad time rejected", () => {
    const base = { symbol: "EURUSD", bid: 1.086, ask: 1.0861 };
    expect(parseOne(metaApiPrice, { ...base, time: new Date(5000) }, "price").time).toBe(5000);
    expect(parseOne(metaApiPrice, { ...base, time: "1970-01-01T00:00:06.000Z" }, "price").time).toBe(6000);
    expect(parseOne(metaApiPrice, { ...base, time: 7000 }, "price").time).toBe(7000);
    expect(() => parseOne(metaApiPrice, { ...base, time: "not a date" }, "price")).toThrow(/invalid time/);
  });

  it("account: R0.2 margin mode mapped; no margin in use → marginLevel null", () => {
    const raw = {
      currency: "USD",
      balance: 1000,
      equity: 1010,
      margin: 0,
      freeMargin: 1010,
      leverage: 500,
      marginMode: "ACCOUNT_MARGIN_MODE_RETAIL_HEDGING",
      tradeAllowed: true,
    };
    expect(parseOne(metaApiAccount, raw, "account")).toMatchObject({
      marginMode: "HEDGING",
      marginLevel: null,
    });
    expect(
      parseOne(
        metaApiAccount,
        { ...raw, margin: 20, marginLevel: 5050, marginMode: "ACCOUNT_MARGIN_MODE_RETAIL_NETTING" },
        "account",
      ),
    ).toMatchObject({
      marginMode: "NETTING",
      marginLevel: 5050,
    });
    expect(() => parseOne(metaApiAccount, { ...raw, marginMode: "WHATEVER" }, "account")).toThrow(
      /unknown margin mode/,
    );
  });
});

describe("toTradeResult", () => {
  it("success response with ids", () => {
    expect(
      toTradeResult(
        "market",
        {
          numericCode: 10009,
          stringCode: "TRADE_RETCODE_DONE",
          message: "Request completed",
          orderId: 46870472,
          positionId: "46870472",
        },
        120,
      ),
    ).toEqual({
      op: "market",
      ok: true,
      class: "success",
      code: 10009,
      stringCode: "TRADE_RETCODE_DONE",
      message: "Request completed",
      latencyMs: 120,
      orderId: "46870472",
      positionId: "46870472",
    });
  });

  it("a TradeError (message + codes) becomes a failed result, classified per op", () => {
    const err = Object.assign(new Error("Invalid stops"), {
      numericCode: 10016,
      stringCode: "TRADE_RETCODE_INVALID_STOPS",
    });
    expect(toTradeResult("modify", err, 80)).toMatchObject({
      ok: false,
      class: "final",
      code: 10016,
      message: "Invalid stops",
    });
  });

  it("string-only codes are understood", () => {
    expect(toTradeResult("close", { stringCode: "TRADE_RETCODE_POSITION_CLOSED" }, 1)).toMatchObject({
      ok: true,
      code: 10036,
      message: "",
    });
  });

  it("no usable code → unknown error, which is ambiguous for an entry (R6.5)", () => {
    expect(toTradeResult("market", { stringCode: "WHO_KNOWS" }, 1)).toMatchObject({
      ok: false,
      class: "ambiguous",
      code: -4,
      stringCode: "WHO_KNOWS",
    });
    expect(toTradeResult("market", {}, 1)).toMatchObject({ class: "ambiguous", stringCode: "UNKNOWN_ERROR" });
  });

  it("an unreadable response is never mistaken for success", () => {
    expect(toTradeResult("modify", "garbage", 1)).toMatchObject({ ok: false, class: "retryable", code: -4 });
    expect(toTradeResult("pending", { numericCode: "10009" }, 1)).toMatchObject({
      ok: false,
      class: "ambiguous",
    });
  });
});
