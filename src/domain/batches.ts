/**
 * OD5 / R9.9: the batches on the account, from what is on the book NOW. A batch is every position and pending order whose magic decodes to the same batchSeq
 * under OUR prefix; manual trades (magic 0) and other EAs are never listed. Pure.
 */
import { decodeMagic } from "./batch";
import { pendingSide } from "./filter";
import type { PendingOrder, Position, Side } from "./types";

export interface BatchSummary {
  readonly batchSeq: number;
  readonly magic: number;
  readonly symbols: readonly string[];
  readonly positions: {
    readonly count: number;
    readonly buys: number;
    readonly sells: number;
    readonly lots: number;
    readonly profit: number;
    readonly withoutStop: number;
  };
  readonly orders: {
    readonly count: number;
    readonly buys: number;
    readonly sells: number;
    readonly lots: number;
  };
}

const round = (n: number, d: number) => Number(n.toFixed(d));

export function groupBatches(
  positions: readonly Position[],
  orders: readonly PendingOrder[],
  prefix: number,
): BatchSummary[] {
  const by = new Map<number, { magic: number; symbols: Set<string>; pos: Position[]; ord: PendingOrder[] }>();
  const slot = (magic: number, seq: number) => {
    const hit = by.get(seq);
    if (hit !== undefined) return hit;
    const fresh = { magic, symbols: new Set<string>(), pos: [] as Position[], ord: [] as PendingOrder[] };
    by.set(seq, fresh);
    return fresh;
  };
  for (const p of positions) {
    const d = decodeMagic(p.magic, prefix);
    if (!d.app) continue;
    const b = slot(p.magic, d.batchSeq);
    b.symbols.add(p.symbol);
    b.pos.push(p);
  }
  for (const o of orders) {
    const d = decodeMagic(o.magic, prefix);
    if (!d.app) continue;
    const b = slot(o.magic, d.batchSeq);
    b.symbols.add(o.symbol);
    b.ord.push(o);
  }
  const count = (xs: readonly Side[], s: Side) => xs.filter((x) => x === s).length;
  return [...by.entries()]
    .sort(([a], [b]) => b - a) // newest batch first
    .map(([batchSeq, b]) => {
      const ps = b.pos.map((p) => p.side);
      const os = b.ord.map((o) => pendingSide(o.type));
      return {
        batchSeq,
        magic: b.magic,
        symbols: [...b.symbols].sort(),
        positions: {
          count: b.pos.length,
          buys: count(ps, "BUY"),
          sells: count(ps, "SELL"),
          lots: round(
            b.pos.reduce((a, p) => a + p.volume, 0),
            8,
          ),
          profit: round(
            b.pos.reduce((a, p) => a + (Number.isFinite(p.profit) ? p.profit : 0), 0),
            2,
          ),
          withoutStop: b.pos.filter((p) => p.sl === null).length,
        },
        orders: {
          count: b.ord.length,
          buys: count(os, "BUY"),
          sells: count(os, "SELL"),
          lots: round(
            b.ord.reduce((a, o) => a + o.volume, 0),
            8,
          ),
        },
      };
    });
}
