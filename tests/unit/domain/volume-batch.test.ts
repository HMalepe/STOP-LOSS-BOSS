import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { batchTags, decodeMagic, encodeMagic, MAGIC_SPAN, MAX_PREFIX } from "@/domain/batch";
import { checkVolume, lotOfSteps, roundDownToStep, stepDecimals, stepsOf } from "@/domain/volume";

const spec = { symbol: "EURUSD", volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };

describe("R5.1 volume on the step grid, in integer steps", () => {
  it("the float traps: 0.29, 0.57, 1.15 are on the grid and stay themselves", () => {
    for (const v of [0.29, 0.57, 1.15, 0.07, 4.35]) {
      expect(stepsOf(v, 0.01)).toBe(Math.round(v * 100));
      expect(roundDownToStep(v, 0.01)).toBe(v);
      expect(checkVolume(v, spec)).toMatchObject({ ok: true, volume: v });
    }
    expect(Math.floor(0.29 / 0.01)).toBe(28); // the bug this guards against
  });
  it("a typed lot off the grid is REJECTED, never silently rounded", () => {
    expect(checkVolume(0.015, spec)).toEqual({
      ok: false,
      message: "0.015 isn't a multiple of 0.01 lots (the step for EURUSD).",
    });
    expect(checkVolume(0.1 + 0.2, spec)).toMatchObject({ ok: true, volume: 0.3 });
  });
  it("min, max, zero and junk", () => {
    expect(checkVolume(0.001, { ...spec, volumeStep: 0.001 })).toMatchObject({
      ok: false,
      message: "The smallest lot for EURUSD is 0.01.",
    });
    expect(checkVolume(51, spec)).toMatchObject({ ok: false, message: "The biggest lot for EURUSD is 50." });
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(checkVolume(bad, spec)).toMatchObject({ ok: false, message: "Enter a lot size above zero." });
    }
    // a minimum that isn't a multiple of the step is allowed (R5.1)
    expect(checkVolume(0.1, { ...spec, volumeMin: 0.05, volumeStep: 0.1 })).toMatchObject({ ok: true });
  });
  it("step decimals and clean lots", () => {
    expect([stepDecimals(0.01), stepDecimals(0.25), stepDecimals(1), stepDecimals(0.001)]).toEqual([
      2, 2, 0, 3,
    ]);
    expect(lotOfSteps(3, 0.1)).toBe(0.3);
    expect(lotOfSteps(7, 0.25)).toBe(1.75);
  });
  it("property: every derived lot is on the grid and never above the request", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.001, max: 100, noNaN: true }),
        fc.constantFrom(0.01, 0.1, 0.05, 0.25, 1),
        (v, step) => {
          const r = roundDownToStep(v, step);
          expect(stepsOf(r || step, step)).not.toBeNull();
          expect(r).toBeLessThanOrEqual(v + 1e-9);
          expect(v - r).toBeLessThan(step + 1e-9);
        },
      ),
    );
  });
  it("junk steps and values are not on a grid", () => {
    expect(stepsOf(1, 0)).toBeNull();
    expect(stepsOf(NaN, 0.01)).toBeNull();
    expect(stepsOf(-1, 0.01)).toBeNull();
  });
});

describe("R9.1 batch identity", () => {
  it("magic = PREFIX × 10^9 + seq; decodes back; manual (0) and other EAs are never ours", () => {
    expect(encodeMagic(7731, 42)).toBe(7_731_000_000_042);
    expect(decodeMagic(7_731_000_000_042, 7731)).toEqual({ app: true, batchSeq: 42 });
    expect(decodeMagic(0, 7731)).toEqual({ app: false });
    expect(decodeMagic(123_456, 7731)).toEqual({ app: false });
    expect(decodeMagic(7_732_000_000_042, 7731)).toEqual({ app: false });
    expect(decodeMagic(1.5e12 + 0.5, 7731)).toEqual({ app: false });
  });
  it("rejects a prefix or sequence that would leave the safe-integer range", () => {
    expect(() => encodeMagic(MAX_PREFIX + 1, 0)).toThrow(/APP_MAGIC_PREFIX/);
    expect(() => encodeMagic(0, 0)).toThrow();
    expect(() => encodeMagic(1, MAGIC_SPAN)).toThrow(/batchSeq/);
    expect(Number.isSafeInteger(encodeMagic(MAX_PREFIX, MAGIC_SPAN - 1))).toBe(true);
  });
  it("property: decode(encode(p, s)) = s for the owner's prefix; a different prefix never matches", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_PREFIX }),
        fc.integer({ min: 0, max: MAGIC_SPAN - 1 }),
        fc.integer({ min: 1, max: MAX_PREFIX }),
        (p, s, other) => {
          expect(decodeMagic(encodeMagic(p, s), p)).toEqual({ app: true, batchSeq: s });
          if (other !== p) expect(decodeMagic(encodeMagic(p, s), other)).toEqual({ app: false });
        },
      ),
    );
  });
  it("comment + clientId ≤ 26 chars for every batch and item; unique per (batch, item)", () => {
    const t = batchTags(7731, 999_999_999, 999);
    expect(t.comment.length + t.clientId.length).toBeLessThanOrEqual(26);
    expect(t).toEqual({ magic: 7_731_999_999_999, comment: "OD:gjdgxr", clientId: "gjdgxr999" });
    expect(batchTags(7731, 1, 0).clientId).not.toBe(batchTags(7731, 1, 1).clientId);
    expect(batchTags(7731, 1, 5).clientId).not.toBe(batchTags(7731, 2, 5).clientId);
    expect(() => batchTags(7731, 1, 1000)).toThrow(/item index/);
    expect(() => batchTags(7731, 1, -1)).toThrow();
  });
});
