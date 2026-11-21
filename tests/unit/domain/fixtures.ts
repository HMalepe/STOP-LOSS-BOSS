import type { Position, Quote, Side, SymbolSpec } from "@/domain/types";

const base = { stopsLevel: 0, freezeLevel: 0, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };

export const EURUSD: SymbolSpec = { ...base, symbol: "EURUSD", digits: 5, point: 0.00001, tickSize: 0.00001 };
export const USDJPY: SymbolSpec = { ...base, symbol: "USDJPY", digits: 3, point: 0.001, tickSize: 0.001 };
export const XAUUSD: SymbolSpec = { ...base, symbol: "XAUUSD", digits: 2, point: 0.01, tickSize: 0.01 };
/** Index with a quarter-point tick: tickSize 0.25 = 25 points. */
export const US30: SymbolSpec = { ...base, symbol: "US30", digits: 2, point: 0.01, tickSize: 0.25 };

export const ALL_SPECS = [EURUSD, USDJPY, XAUUSD, US30] as const;

export function quote(bid: number, ask: number, symbol = "EURUSD"): Quote {
  return { symbol, bid, ask, time: 1_763_769_600_000 };
}

let seq = 0;
export function position(side: Side, over: Partial<Position> = {}): Position {
  seq += 1;
  return {
    id: String(1000 + seq),
    symbol: "EURUSD",
    side,
    volume: 0.1,
    openPrice: 1.085,
    sl: null,
    tp: null,
    profit: 0,
    magic: 0,
    ...over,
  };
}
