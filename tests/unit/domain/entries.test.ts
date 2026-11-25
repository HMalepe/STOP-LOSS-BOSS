import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildMarketBatch,
  entryClientId,
  identityFromSeq,
  MAX_BATCH_ORDERS,
  type BatchIdentity,
  type MarketBatchRequest,
} from "@/domain/entries";
import { toPoints } from "@/domain/price";
import { EURUSD, US30, XAUUSD, quote } from "./fixtures";

const ID: BatchIdentity = { magic: 7_731_000_000_042, batchShort: "k3x9", planShort: "p7Xa" };
const CAPS = { maxOrdersPerAction: 100, maxTotalLots: 5 };
const Q = quote(1.086, 1.0861); // spread 10 points
const snap = { spec: EURUSD, quote: Q };
const req = (over: Partial<MarketBatchRequest> = {}): MarketBatchRequest => ({
  symbol: "EURUSD",
  side: "BUY",
  count: 3,
  volume: 0.05,
  stopLoss: { kind: "points", value: 150 },
  takeProfit: { kind: "points", value: 300 },
  ...over,
});
const build = (r = req(), s: Parameters<typeof buildMarketBatch>[1] = snap, caps = CAPS) =>
  buildMarketBatch(r, s, ID, caps);
const ok = (r: ReturnType<typeof build>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.plan;
};

describe("OD1 bulk market entries", () => {
  it("N identical orders, each carrying the batch magic, a human comment and a unique clientId (R9.1)", () => {
    const p = ok(build());
    expect(p.items).toHaveLength(3);
    expect(p.items.map((i) => i.clientId)).toEqual(["p7Xa000", "p7Xa001", "p7Xa002"]);
    for (const i of p.items) {
      expect(i).toMatchObject({
        op: "market",
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.05,
        magic: ID.magic,
        comment: "OD:k3x9",
      });
    }
    expect(p).toMatchObject({ count: 3, volume: 0.05, totalLots: 0.15 });
  });

  it("R5.3: points SL/TP are measured from the expected fill (buy: ask, sell: bid)", () => {
    const buy = ok(build()).items[0];
    expect([buy?.sl, buy?.tp]).toEqual([1.0846, 1.0891]); // ask 1.0861 ∓/± 150/300 pts
    const sell = ok(build(req({ side: "SELL" }))).items[0];
    expect([sell?.sl, sell?.tp]).toEqual([1.0875, 1.083]); // bid 1.0860 ± 150 / ∓ 300
  });

  it("R5.3: levels are validated against the CLOSING side (buy → bid): an SL inside the spread is refused, whole plan", () => {
    // Buy SL 5 pts below ask = 5 pts ABOVE bid: it would stop out instantly. Refused, nothing to send.
    const r = build(req({ stopLoss: { kind: "points", value: 5 } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("PLAN_INVALID");
    expect(r.error.message).toMatch(/SL/);
  });

  it("R5.3 + stops level: the minimum distance d applies to entries too", () => {
    const spec = { ...EURUSD, stopsLevel: 200 };
    expect(build(req(), { spec, quote: Q }).ok).toBe(false); // 150 pts < d (200 + 2 buffer)
    expect(
      build(req({ stopLoss: { kind: "points", value: 300 }, takeProfit: { kind: "points", value: 400 } }), {
        spec,
        quote: Q,
      }).ok,
    ).toBe(true);
  });

  it("absolute prices are rounded to the tick (US30 quarter ticks) and validated the same way", () => {
    const usq = quote(42_000, 42_002, "US30");
    const p = ok(
      build(
        req({
          symbol: "US30",
          stopLoss: { kind: "price", value: 41_950.1 },
          takeProfit: { kind: "price", value: 42_100.13 },
        }),
        { spec: US30, quote: usq },
      ),
    );
    expect([p.items[0]?.sl, p.items[0]?.tp]).toEqual([41_950, 42_100.25]);
  });

  it("non-negotiable 9: no SL requested is allowed but loud; an SL requested is never dropped, whatever happens", () => {
    const p = ok(build(req({ stopLoss: undefined })));
    expect(p.items[0]?.sl).toBeNull();
    expect(p.warnings).toContain("No stop loss: the loss on these orders is limited only by your account.");
  });

  it("R5.1: a typed lot must be ON the step grid: refused with the reason, never silently rounded; min/max enforced", () => {
    const r = build(req({ volume: 0.057 }));
    expect(!r.ok && r.error.message).toBe("0.057 isn't a multiple of the lot step 0.01.");
    expect(ok(build(req({ volume: 0.29 }))).volume).toBe(0.29); // 0.29 / 0.01 = 28.999… in floats: a naive floor gave 0.28
    expect(build(req({ volume: 0.009 })).ok).toBe(false);
    expect(build(req({ volume: 101 })).ok).toBe(false);
    expect(ok(build(req({ volume: 0.07 }))).volume).toBe(0.07); // 0.07/0.01 is 7.000000000000001 in floats
  });

  it("R5.2: count and total lots over the caps refuse, with the numbers", () => {
    const many = build(req({ count: 101 }));
    expect(!many.ok && many.error.message).toBe("101 orders is over your cap of 100 per action.");
    const heavy = build(req({ count: 11, volume: 0.5 }));
    expect(!heavy.ok && heavy.error.message).toBe("5.5 lots in total is over your cap of 5.");
    expect(build(req({ count: 10, volume: 0.5 })).ok).toBe(true);
  });

  it("R0.1/R0.6: bad spec or quote → BROKER_UNAVAILABLE; nonsense input → VALIDATION; never throws", () => {
    expect(build(req(), { spec: null, quote: Q })).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE" },
    });
    expect(build(req(), { spec: EURUSD, quote: null })).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE" },
    });
    expect(build(req(), { spec: EURUSD, quote: quote(0, 1) })).toMatchObject({
      ok: false,
      error: { code: "BROKER_UNAVAILABLE" },
    });
    expect(build(req(), { spec: XAUUSD, quote: Q })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    for (const bad of [
      req({ count: 0 }),
      req({ count: 1.5 }),
      req({ volume: Number.NaN }),
      req({ stopLoss: { kind: "points", value: 0 } }),
      req({ stopLoss: { kind: "points", value: 1.5 } }),
      req({ stopLoss: { kind: "points", value: 2_000_000 } }),
      req({ stopLoss: { kind: "price", value: Number.POSITIVE_INFINITY } }),
    ]) {
      expect(build(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("R9.1: comment + clientId must fit MetaApi's 26 characters, checked with the largest index", () => {
    // "OD:" + 12 = 15, plus "yyyyyyyy" + "099" = 11 → 26 fits; one more character doesn't.
    const fits: BatchIdentity = { ...ID, batchShort: "x".repeat(12), planShort: "y".repeat(8) };
    expect(buildMarketBatch(req({ count: 100 }), snap, fits, CAPS).ok).toBe(true);
    const long: BatchIdentity = { ...fits, planShort: "y".repeat(9) };
    const r = buildMarketBatch(req({ count: 100 }), snap, long, CAPS);
    expect(!r.ok && r.error.code).toBe("VALIDATION");
  });

  it("TP is optional; a broken TP refuses like a broken SL; a bad magic is refused", () => {
    expect(ok(build(req({ takeProfit: undefined }))).items[0]?.tp).toBeNull();
    expect(build(req({ takeProfit: { kind: "points", value: 0 } })).ok).toBe(false);
    expect(build(req({ takeProfit: { kind: "price", value: 1.085 } }))).toMatchObject({
      ok: false,
      error: { code: "PLAN_INVALID" },
    });
    for (const magic of [0, -1, 2 ** 53]) {
      expect(buildMarketBatch(req(), snap, { ...ID, magic }, CAPS).ok, String(magic)).toBe(false);
    }
  });

  it("R9.1: batches can never share a clientId (the review's collision: seq 10 item 10 vs seq 361 item 0)", () => {
    expect(entryClientId(identityFromSeq(7731, 10), 10)).not.toBe(
      entryClientId(identityFromSeq(7731, 361), 0),
    );
    expect(entryClientId(identityFromSeq(7731, 10), 10)).toBe("a010");
    expect(entryClientId(identityFromSeq(7731, 361), 0)).toBe("a1000");
  });

  it("R9.1 property: (seq, index) → clientId is injective over many batches; magic decodes back to the seq", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999_999 }),
        fc.integer({ min: 1, max: 999_999_999 }),
        fc.integer({ min: 0, max: MAX_BATCH_ORDERS - 1 }),
        fc.integer({ min: 0, max: MAX_BATCH_ORDERS - 1 }),
        (s1, s2, i1, i2) => {
          const a = entryClientId(identityFromSeq(7731, s1), i1);
          const b = entryClientId(identityFromSeq(7731, s2), i2);
          if (s1 !== s2 || i1 !== i2) expect(a).not.toBe(b);
          expect(identityFromSeq(7731, s1).magic % 1e9).toBe(s1);
          expect(Math.floor(identityFromSeq(7731, s1).magic / 1e9)).toBe(7731);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("R9.1: a batch is capped at 1000 orders (3-digit index); bad sequences throw (a bug, not input)", () => {
    expect(() => identityFromSeq(7731, 0)).toThrow(RangeError);
    expect(() => identityFromSeq(7731, 1_000_000_000)).toThrow(RangeError);
    expect(() => identityFromSeq(0, 1)).toThrow(RangeError);
    const r = buildMarketBatch(req({ count: 1001 }), snap, ID, {
      maxOrdersPerAction: 5000,
      maxTotalLots: 1e6,
    });
    expect(!r.ok && r.error.message).toBe("A batch can carry at most 1000 orders.");
  });

  it("property: every item of an accepted plan carries exactly the requested stop, valid against the closing side", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("BUY" as const, "SELL" as const),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.integer({ min: 0, max: 300 }),
        (side, slPts, tpPts, stopsLevel) => {
          const spec = { ...EURUSD, stopsLevel };
          const r = buildMarketBatch(
            req({
              side,
              stopLoss: { kind: "points", value: slPts },
              takeProfit: { kind: "points", value: tpPts },
            }),
            { spec, quote: Q },
            ID,
            CAPS,
          );
          if (!r.ok) return;
          const bid = toPoints(Q.bid, spec);
          const ask = toPoints(Q.ask, spec);
          const d = stopsLevel + 2;
          for (const i of r.plan.items) {
            expect(i.sl).not.toBeNull();
            const sl = toPoints(i.sl ?? 0, spec);
            if (side === "BUY") expect(sl).toBeLessThan(bid - d);
            else expect(sl).toBeGreaterThan(ask + d);
          }
        },
      ),
    );
  });
});
