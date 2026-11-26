import { describe, expect, it } from "vitest";
import { encodeMagic } from "@/domain/batch";
import { groupBatches } from "@/domain/batches";
import { buildPlan } from "@/domain/plan";
import type { PendingOrder, Position } from "@/domain/types";

const PREFIX = 7731;
const pos = (id: string, magic: number, over: Partial<Position> = {}): Position => ({
  id,
  symbol: "EURUSD",
  side: "BUY",
  volume: 0.1,
  openPrice: 1.08,
  sl: 1.07,
  tp: null,
  profit: 1.5,
  magic,
  ...over,
});
const ord = (id: string, magic = 0, over: Partial<PendingOrder> = {}): PendingOrder => ({
  id,
  symbol: "EURUSD",
  type: "BUY_LIMIT",
  volume: 0.1,
  openPrice: 1.07,
  sl: null,
  tp: null,
  magic,
  ...over,
});
const A = encodeMagic(PREFIX, 4);
const B = encodeMagic(PREFIX, 9);

describe("OD5 / R9.9 batches on the book", () => {
  it("groups positions and pending orders by batch, newest first; manual (0) and other EAs' magics never appear", () => {
    const out = groupBatches(
      [
        pos("1", A),
        pos("2", A, { side: "SELL", profit: -4, sl: null }),
        pos("3", B, { symbol: "XAUUSD" }),
        pos("4", 0),
        pos("5", 123_456),
        pos("6", encodeMagic(9999, 4)),
      ],
      [ord("o1", A), ord("o2", A, { type: "SELL_STOP", volume: 0.2 }), ord("o3", 0)],
      PREFIX,
    );
    expect(out.map((b) => b.batchSeq)).toEqual([9, 4]);
    expect(out[1]).toEqual({
      batchSeq: 4,
      magic: A,
      symbols: ["EURUSD"],
      positions: { count: 2, buys: 1, sells: 1, lots: 0.2, profit: -2.5, withoutStop: 1 },
      orders: { count: 2, buys: 1, sells: 1, lots: 0.3 },
    });
    expect(out[0]).toMatchObject({
      symbols: ["XAUUSD"],
      positions: { count: 1 },
      orders: { count: 0, lots: 0 },
    });
  });
  it("a batch that is only pending orders still appears; an empty book has no batches; unknown profit counts as 0", () => {
    expect(groupBatches([], [ord("o", A)], PREFIX)).toHaveLength(1);
    expect(groupBatches([], [], PREFIX)).toEqual([]);
    expect(groupBatches([pos("1", A, { profit: Number.NaN })], [], PREFIX)[0]?.positions.profit).toBe(0);
  });
  it("lots add without float dust", () => {
    const out = groupBatches([pos("1", A, { volume: 0.1 }), pos("2", A, { volume: 0.2 })], [], PREFIX);
    expect(out[0]?.positions.lots).toBe(0.3);
  });
});

describe("OD5 cancel plans (R4.3/R4.8)", () => {
  const snap = (orders: PendingOrder[], positions: Position[] = []) => ({
    positions,
    orders,
    spec: null,
    quote: null,
  });
  const filter = (o: object = {}) => ({ symbol: "EURUSD", side: "ALL" as const, ...o });
  it("cancels only the matching pending orders (symbol, side by order type, magic); positions are never touched; needs neither spec nor quote", () => {
    const r = buildPlan(
      { action: "cancel", filter: filter({ magic: A }) },
      snap(
        [
          ord("o2", A),
          ord("o1", A, { type: "SELL_LIMIT" }),
          ord("x", B),
          ord("m", 0),
          ord("g", A, { symbol: "GBPUSD" }),
        ],
        [pos("p", A)],
      ),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.plan.items).toEqual([
      { op: "cancel", orderId: "o1" },
      { op: "cancel", orderId: "o2" },
    ]);
    expect(r.plan.breakdown).toEqual({ buys: 1, sells: 1, cancels: 2 });
    expect(r.plan.warnings[0]).toBe("Open positions are not touched. Only pending orders are cancelled.");
  });
  it("side filter uses the order TYPE; nothing matching → NO_MATCH; duplicate tickets cancel once, with a warning", () => {
    const buys = buildPlan(
      { action: "cancel", filter: filter({ side: "BUY" }) },
      snap([ord("a"), ord("b", A, { type: "SELL_STOP" })]),
    );
    expect(buys.ok && buys.plan.items).toEqual([{ op: "cancel", orderId: "a" }]);
    expect(buildPlan({ action: "cancel", filter: filter({ magic: 5 }) }, snap([ord("a")]))).toEqual({
      ok: false,
      error: { code: "NO_MATCH", message: "No pending orders match." },
    });
    const dup = buildPlan({ action: "cancel", filter: filter() }, snap([ord("a"), ord("a")]));
    expect(dup.ok && dup.plan.items).toHaveLength(1);
    expect(dup.ok && dup.plan.warnings[1]).toMatch(/duplicate tickets \(duplicate order a\)/);
    expect(buildPlan({ action: "cancel", filter: filter({ symbol: " " }) }, snap([]))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
  });
});
