import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareIds, duplicateIds, matchesOrder, matchesPosition, pendingSide } from "@/domain/filter";
import { buildPlan, type MarketSnapshot, type PlanRequest, type PlanResult } from "@/domain/plan";
import { fromPoints, toPoints } from "@/domain/price";
import type { PendingOrder, PlanItem, Position, PositionFilter, SymbolSpec } from "@/domain/types";
import { EURUSD, position, quote, US30, XAUUSD } from "./fixtures";

// bid 1.08600, ask 1.08610, stops 10, freeze 5, buffer 2 → d = 12.
const SPEC: SymbolSpec = { ...EURUSD, stopsLevel: 10, freezeLevel: 5 };
const Q = quote(1.086, 1.0861);
const ALL: PositionFilter = { symbol: "EURUSD", side: "ALL" };

function snap(positions: Position[], over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return { positions, orders: [], spec: SPEC, quote: Q, ...over };
}

function ok(r: PlanResult) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.plan;
}

function err(r: PlanResult) {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

const modifies = (items: readonly PlanItem[]) => items.filter((i) => i.op === "modify");

function order(over: Partial<PendingOrder> = {}): PendingOrder {
  return {
    id: "9001",
    symbol: "EURUSD",
    type: "BUY_LIMIT",
    volume: 0.1,
    openPrice: 1.08,
    sl: null,
    tp: null,
    magic: 0,
    ...over,
  };
}

describe("VALIDATION", () => {
  it.each<[string, PlanRequest, string]>([
    [
      "empty symbol",
      { action: "close", filter: { symbol: " ", side: "ALL" }, cancelPending: false },
      "Pick a symbol.",
    ],
    ["no levels", { action: "levels", filter: ALL }, "Enter an SL, a TP, or both."],
    ["negative SL", { action: "levels", filter: ALL, stopLoss: -1 }, "SL must be a positive price."],
    ["NaN TP", { action: "levels", filter: ALL, takeProfit: Number.NaN }, "TP must be a positive price."],
    ["zero trigger", { action: "closeAt", filter: ALL, price: 0 }, "Enter a valid trigger price."],
  ])("%s", (_n, req, message) => {
    expect(err(buildPlan(req, snap([position("BUY")])))).toEqual({ code: "VALIDATION", message });
  });
});

describe("R0.1 no spec or quote, no plan (06-TESTING #19)", () => {
  const req: PlanRequest = { action: "levels", filter: ALL, stopLoss: 1.08 };
  const one = [position("BUY")];

  it("missing spec → BROKER_UNAVAILABLE, never a d = 0 fallback", () => {
    expect(err(buildPlan(req, snap(one, { spec: null })))).toMatchObject({
      code: "BROKER_UNAVAILABLE",
      details: ["spec missing"],
    });
  });

  it.each<[string, Partial<MarketSnapshot>, string]>([
    ["spec for another symbol", { spec: { ...SPEC, symbol: "GBPUSD" } }, "spec is for GBPUSD"],
    ["broken spec", { spec: { ...SPEC, point: 0 } }, "spec: point must be > 0"],
    ["missing quote", { quote: null }, "quote missing"],
    ["quote for another symbol", { quote: quote(1.27, 1.2701, "GBPUSD") }, "quote is for GBPUSD"],
    ["crossed quote", { quote: quote(1.0861, 1.086) }, "quote: ask must be ≥ bid"],
  ])("%s", (_n, over, detail) => {
    const e = err(buildPlan(req, snap(one, over)));
    expect(e.code).toBe("BROKER_UNAVAILABLE");
    if (e.code === "BROKER_UNAVAILABLE") expect(e.details).toContain(detail);
  });
});

describe("R0.3 unique tickets", () => {
  it("duplicateIds finds repeats, sorted", () => {
    expect(duplicateIds(["b", "a", "b", "c", "a", "b"])).toEqual(["a", "b"]);
    expect(duplicateIds([])).toEqual([]);
    expect(compareIds("a", "a")).toBe(0);
  });

  it.each<PlanRequest>([
    { action: "levels", filter: ALL, stopLoss: 1.08 },
    { action: "closeAt", filter: ALL, price: 1.09 },
  ])("refuses a snapshot with a duplicate position ticket ($action)", (req) => {
    const twin = position("BUY", { id: "dup" });
    const e = err(buildPlan(req, snap([twin, { ...twin }])));
    expect(e).toEqual({
      code: "BROKER_UNAVAILABLE",
      message: "Broker sent duplicate tickets. Refresh and try again.",
      details: ["duplicate position dup"],
    });
  });

  it("refuses duplicate order tickets for non-close actions", () => {
    const e = err(
      buildPlan(
        { action: "levels", filter: ALL, stopLoss: 1.08 },
        snap([position("BUY")], { orders: [order(), order()] }),
      ),
    );
    if (e.code === "BROKER_UNAVAILABLE") expect(e.details).toEqual(["duplicate order 9001"]);
    else expect.unreachable();
  });

  it("close-now de-duplicates instead of refusing: each ticket closes once, with a warning (R4.7)", () => {
    const twin = position("BUY", { id: "dup" });
    const plan = ok(
      buildPlan(
        { action: "close", filter: ALL, cancelPending: true },
        snap([twin, { ...twin }], { orders: [order(), order()] }),
      ),
    );
    expect(plan.items).toEqual([
      { op: "close", positionId: "dup", side: "BUY", volume: 0.1 },
      { op: "cancel", orderId: "9001" },
    ]);
    expect(plan.warnings).toContain(
      "Broker sent duplicate tickets (duplicate position dup, duplicate order 9001); each closes once.",
    );
  });
});

describe("§1 filters", () => {
  it("symbol, side, magic and in-profit-only", () => {
    const p = position("BUY", { magic: 7, profit: 5 });
    expect(matchesPosition(p, ALL)).toBe(true);
    expect(matchesPosition(p, { symbol: "GBPUSD", side: "ALL" })).toBe(false);
    expect(matchesPosition(p, { ...ALL, side: "SELL" })).toBe(false);
    expect(matchesPosition(p, { ...ALL, side: "BUY", magic: 7 })).toBe(true);
    expect(matchesPosition(p, { ...ALL, magic: 8 })).toBe(false);
    expect(matchesPosition(p, { ...ALL, inProfitOnly: true })).toBe(true);
    expect(matchesPosition({ ...p, profit: 0 }, { ...ALL, inProfitOnly: true })).toBe(false);
    expect(matchesPosition({ ...p, profit: -1 }, { ...ALL, inProfitOnly: false })).toBe(true);
  });

  it("R4.8 orders: symbol, side via type, magic; in-profit-only ignored", () => {
    expect(pendingSide("BUY_STOP")).toBe("BUY");
    expect(pendingSide("SELL_LIMIT")).toBe("SELL");
    expect(pendingSide("BUY_STOP_LIMIT")).toBe("BUY");
    expect(pendingSide("SELL_STOP_LIMIT")).toBe("SELL");
    expect(matchesOrder(order(), { ...ALL, inProfitOnly: true })).toBe(true);
    expect(matchesOrder(order(), { ...ALL, side: "SELL" })).toBe(false);
    expect(matchesOrder(order({ type: "SELL_STOP" }), { ...ALL, side: "SELL" })).toBe(true);
    expect(matchesOrder(order(), { symbol: "GBPUSD", side: "ALL" })).toBe(false);
    expect(matchesOrder(order({ magic: 3 }), { ...ALL, magic: 4 })).toBe(false);
  });

  it("NO_MATCH when nothing matches", () => {
    expect(
      err(
        buildPlan(
          { action: "levels", filter: { ...ALL, side: "SELL" }, stopLoss: 1.09 },
          snap([position("BUY")]),
        ),
      ).code,
    ).toBe("NO_MATCH");
  });
});

describe("levels: F1 bulk SL/TP", () => {
  it("acceptance: 1,000 positions, SL only → all modified, every TP preserved (06-TESTING #1)", () => {
    const positions = Array.from({ length: 1000 }, (_, i) =>
      position("BUY", { id: `p${String(i).padStart(4, "0")}`, sl: null, tp: 1.09 + (i % 50) / 100000 }),
    );
    const plan = ok(buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap(positions)));
    expect(plan.items).toHaveLength(1000);
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const item of modifies(plan.items)) {
      expect(item.sl).toBe(1.08);
      // Preserved exactly at point precision (raw floats like 1.0900100000000001 come back as 1.09001).
      // Not re-rounded to tick: the broker already holds this level, we must send back the same one.
      expect(item.tp).toBe(fromPoints(toPoints(byId.get(item.positionId)!.tp!, SPEC), SPEC));
    }
    expect(plan.breakdown).toEqual({ buys: 1000, sells: 0 });
  });

  it("rounds the requested level to the tick grid (index quarter ticks)", () => {
    const spec = { ...US30 };
    const p = position("BUY", { symbol: "US30", openPrice: 42000 });
    const plan = ok(
      buildPlan(
        { action: "levels", filter: { symbol: "US30", side: "ALL" }, stopLoss: 41900.13 },
        { positions: [p], orders: [], spec, quote: quote(42000, 42001, "US30") },
      ),
    );
    expect(modifies(plan.items)[0]?.sl).toBe(41900.25);
  });

  it("float edge: 2650.1 + 0.2 is treated as 2650.30 (06-TESTING #11)", () => {
    const p = position("SELL", { symbol: "XAUUSD", openPrice: 2650 });
    const plan = ok(
      buildPlan(
        { action: "levels", filter: { symbol: "XAUUSD", side: "ALL" }, takeProfit: 2650.1 + 0.2 },
        { positions: [p], orders: [], spec: XAUUSD, quote: quote(2655, 2655.3, "XAUUSD") },
      ),
    );
    expect(modifies(plan.items)[0]?.tp).toBe(2650.3);
  });

  it("R2.6: one bad side rejects the whole plan, grouped per side with the boundary", () => {
    const positions = [
      ...Array.from({ length: 13 }, () => position("SELL")),
      ...Array.from({ length: 39 }, () => position("BUY")),
    ];
    // SL 1.08615: fine for buys? No: buy SL must be below 1.08588. Bad for sells too: must be above 1.08622.
    const e = err(buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08615 }, snap(positions)));
    expect(e.code).toBe("PLAN_INVALID");
    if (e.code !== "PLAN_INVALID") return;
    expect(e.details).toEqual([
      {
        rule: "R2.1",
        side: "BUY",
        level: "SL",
        boundary: 1.08588,
        count: 39,
        message: "Buy SL must be below 1.08588 (39 positions, R2.1).",
      },
      {
        rule: "R2.3",
        side: "SELL",
        level: "SL",
        boundary: 1.08622,
        count: 13,
        message: "Sell SL must be above 1.08622 (13 positions, R2.3).",
      },
    ]);
    expect(e.message).toContain("Bid 1.08600 / Ask 1.08610.");
  });

  it("R2.6: a single invalid position is enough to reject, and the message is singular", () => {
    const e = err(buildPlan({ action: "levels", filter: ALL, takeProfit: 1.08605 }, snap([position("BUY")])));
    expect(e.message).toContain("Buy TP must be above 1.08612 (1 position, R2.2).");
  });

  it("R2.8 and R2.9 skips are listed with plain reasons", () => {
    const same = position("BUY", { sl: 1.08 });
    const frozen = position("BUY", { tp: 1.08605 });
    const moved = position("BUY", { sl: 1.07 });
    const plan = ok(
      buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([same, frozen, moved])),
    );
    expect(plan.items.map((i) => (i.op === "modify" ? i.positionId : ""))).toEqual([moved.id]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { id: same.id, reason: "unchanged" },
        { id: frozen.id, reason: "frozen: TP 1.08605 is within the freeze level (5 points)" },
      ]),
    );
  });

  it("everything skipped → empty plan with a warning, not an error", () => {
    const plan = ok(
      buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([position("BUY", { sl: 1.08 })])),
    );
    expect(plan.items).toEqual([]);
    expect(plan.warnings[0]).toMatch(/^Nothing to change/);
  });

  it("R2.10 order: no SL first, then biggest loser, then id", () => {
    const a = position("BUY", { id: "a", sl: 1.07, profit: -50 });
    const b = position("BUY", { id: "b", sl: null, profit: 10 });
    const c = position("BUY", { id: "c", sl: null, profit: -5 });
    const d = position("BUY", { id: "d", sl: 1.07, profit: -50 });
    const plan = ok(buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([a, b, c, d])));
    expect(modifies(plan.items).map((i) => i.positionId)).toEqual(["c", "b", "a", "d"]);
  });

  it("returns the quote it was built on, on the tick grid", () => {
    const plan = ok(buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([position("BUY")])));
    expect(plan.quote).toEqual({ bid: 1.086, ask: 1.0861, time: Q.time });
  });
});

describe("closeAt: F2 close all at price", () => {
  const mixed = () => [
    ...Array.from({ length: 39 }, () => position("BUY")),
    ...Array.from({ length: 13 }, () => position("SELL")),
  ];

  it("acceptance: X above market → buys TP = X, sells SL = X (06-TESTING #2)", () => {
    const plan = ok(buildPlan({ action: "closeAt", filter: ALL, price: 1.09 }, snap(mixed())));
    expect(plan.breakdown).toEqual({ buys: 39, sells: 13, asTP: 39, asSL: 13 });
    for (const item of modifies(plan.items)) {
      if (item.side === "BUY") expect([item.tp, item.sl]).toEqual([1.09, null]);
      else expect([item.sl, item.tp]).toEqual([1.09, null]);
    }
  });

  it("acceptance: X below market → buys SL = X, sells TP = X", () => {
    const plan = ok(buildPlan({ action: "closeAt", filter: ALL, price: 1.08 }, snap(mixed())));
    expect(plan.breakdown).toEqual({ buys: 39, sells: 13, asTP: 13, asSL: 39 });
  });

  it("R3.1: inside the stop distance → rejected with the reason and Close All Now (06-TESTING #3)", () => {
    // 1.08605: 5 points from bid and 5 from ask, both inside d = 12.
    const e = err(buildPlan({ action: "closeAt", filter: ALL, price: 1.08605 }, snap(mixed())));
    expect(e.code).toBe("PLAN_INVALID");
    expect(e.message).toContain("1.08605 is too close to the bid (1.08600) for 39 buys");
    expect(e.message).toContain("1.08605 is too close to the ask (1.08610) for 13 sells");
    expect(e.message).toContain("Use Close All Now instead.");
  });

  it("R3.1: one side too close is enough to reject", () => {
    // 1.08614: buys are 14 points from bid (> 12, valid TP); sells are 4 from ask (too close).
    const e = err(buildPlan({ action: "closeAt", filter: ALL, price: 1.08614 }, snap(mixed())));
    expect(e.code).toBe("PLAN_INVALID");
    if (e.code === "PLAN_INVALID") expect(e.details.map((d) => `${d.rule}:${d.side}`)).toEqual(["R3.1:SELL"]);
  });

  it("R3.5 warning always; R3.6 bid/ask timing warning only when both sides are in the plan", () => {
    const both = ok(buildPlan({ action: "closeAt", filter: ALL, price: 1.09 }, snap(mixed())));
    expect(both.warnings.some((w) => w.includes("(R3.5)"))).toBe(true);
    expect(both.warnings.find((w) => w.includes("(R3.6)"))).toContain("Spread is 10 points now");

    const buysOnly = ok(
      buildPlan({ action: "closeAt", filter: { ...ALL, side: "BUY" }, price: 1.09 }, snap(mixed())),
    );
    expect(buysOnly.warnings.some((w) => w.includes("(R3.6)"))).toBe(false);
  });

  it("already set → skipped, and an all-skipped plan warns", () => {
    const plan = ok(
      buildPlan({ action: "closeAt", filter: ALL, price: 1.09 }, snap([position("BUY", { tp: 1.09 })])),
    );
    expect(plan.items).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("unchanged");
    expect(plan.breakdown).toMatchObject({ asTP: 0, asSL: 0 });
    expect(plan.warnings.some((w) => w.startsWith("Nothing to change"))).toBe(true);
  });
});

describe("close: F3 close all now", () => {
  it("R4.6: biggest loser first, then id; carries volume", () => {
    const positions = [
      position("BUY", { id: "w", profit: 20, volume: 0.2 }),
      position("SELL", { id: "l2", profit: -80 }),
      position("BUY", { id: "l1", profit: -80 }),
      position("BUY", { id: "z", profit: -1 }),
    ];
    const plan = ok(buildPlan({ action: "close", filter: ALL, cancelPending: false }, snap(positions)));
    expect(plan.items.map((i) => (i.op === "close" ? i.positionId : ""))).toEqual(["l1", "l2", "z", "w"]);
    expect(plan.items[3]).toEqual({ op: "close", positionId: "w", side: "BUY", volume: 0.2 });
    expect(plan.breakdown).toEqual({ buys: 3, sells: 1, cancels: 0 });
  });

  it("R4.3/R4.8: cancels matching pending orders after the positions", () => {
    const orders = [
      order({ id: "o2" }),
      order({ id: "o1" }),
      order({ id: "o3", type: "SELL_LIMIT" }),
      order({ id: "x", symbol: "GBPUSD" }),
    ];
    const plan = ok(
      buildPlan(
        { action: "close", filter: { ...ALL, side: "BUY" }, cancelPending: true },
        snap([position("BUY")], { orders }),
      ),
    );
    expect(plan.items.slice(1)).toEqual([
      { op: "cancel", orderId: "o1" },
      { op: "cancel", orderId: "o2" },
    ]);
    expect(plan.breakdown.cancels).toBe(2);
  });

  it("only pending orders and cancelPending → still a plan", () => {
    const plan = ok(
      buildPlan({ action: "close", filter: ALL, cancelPending: true }, snap([], { orders: [order()] })),
    );
    expect(plan.items).toEqual([{ op: "cancel", orderId: "9001" }]);
  });

  it("orders are ignored unless cancelPending", () => {
    expect(
      err(buildPlan({ action: "close", filter: ALL, cancelPending: false }, snap([], { orders: [order()] })))
        .code,
    ).toBe("NO_MATCH");
  });

  it("R4.7: a missing spec and quote never block close-now", () => {
    const plan = ok(
      buildPlan(
        { action: "close", filter: ALL, cancelPending: false },
        snap([position("BUY")], { spec: null, quote: null }),
      ),
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.quote).toBeNull();
    expect(plan.warnings).toEqual(["Live price unavailable. Positions still close at market."]);
  });

  it("R4.7: shows the quote when it's usable", () => {
    const plan = ok(
      buildPlan({ action: "close", filter: ALL, cancelPending: false }, snap([position("BUY")])),
    );
    expect(plan.quote).toEqual({ bid: 1.086, ask: 1.0861, time: Q.time });
    expect(plan.warnings).toEqual([]);
  });
});

describe("determinism and speed", () => {
  const sides = fc.constantFrom<"BUY" | "SELL">("BUY", "SELL");
  const posArb = fc.record({
    side: sides,
    profit: fc.integer({ min: -100, max: 100 }),
    sl: fc.option(fc.constantFrom(1.07, 1.075)),
  });

  it("the same positions in any order give an identical plan (preview hash stays stable)", () => {
    fc.assert(
      fc.property(
        fc.array(posArb, { minLength: 1, maxLength: 40 }),
        fc.constantFrom<PlanRequest>(
          { action: "levels", filter: ALL, stopLoss: 1.08 },
          { action: "closeAt", filter: ALL, price: 1.09 },
          { action: "close", filter: ALL, cancelPending: false },
        ),
        fc.integer(),
        (specs, req, seed) => {
          const positions = specs.map((s, i) =>
            position(s.side, { id: `id${i}`, profit: s.profit, sl: s.side === "BUY" ? s.sl : null }),
          );
          const shuffled = [...positions].sort(
            (a, b) => ((a.id.length * seed) % 7) - ((b.id.length * seed) % 7) || b.id.localeCompare(a.id),
          );
          expect(buildPlan(req, snap(shuffled))).toEqual(buildPlan(req, snap(positions)));
        },
      ),
    );
  });

  it("builds a 1,000-position plan well inside the preview budget", () => {
    const positions = Array.from({ length: 1000 }, (_, i) =>
      position(i % 3 === 0 ? "SELL" : "BUY", { id: `p${i}`, profit: (i % 17) - 8 }),
    );
    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      ok(buildPlan({ action: "closeAt", filter: ALL, price: 1.09 }, snap(positions)));
    }
    const perPlan = (performance.now() - start) / 5;
    expect(perPlan).toBeLessThan(100);
  });
});

describe("R7.1: modify items carry the levels the preview saw", () => {
  it("before = the position's levels at preview, on the point grid", () => {
    const pos = position("BUY", { sl: 1.07, tp: 1.0900100000000001 });
    const plan = ok(buildPlan({ action: "levels", filter: ALL, stopLoss: 1.08 }, snap([pos])));
    expect(modifies(plan.items)[0]?.before).toEqual({ sl: 1.07, tp: 1.09001 });
  });
});
