/**
 * Zod schemas for MetaApi data (shapes verified from metaapi.cloud-sdk@29.3.4, docs/09-PERFORMANCE.md).
 * They check shape and map to domain types. Value sanity (R0.5) stays in the domain so close-now can still act on odd data.
 * MT5 uses 0 for "no level": mapped to null here, once, so the domain never sees a 0 level.
 */
import { z } from "zod";
import type { PendingOrder, PendingType, Position, Quote, SymbolSpec } from "@/domain/types";
import type { AccountInfo, AccountTradeMode, MarginMode, TradeResult } from "./BrokerProvider";
import { classify, codeFromString, codeName, type BrokerOp } from "./retcodes";
import { BrokerError } from "./BrokerProvider";

/** Round money to cents; "+ 0" turns -0 into 0 so logs and equality checks stay clean. */
const cents = (n: number) => Math.round(n * 100) / 100 + 0;

const id = z.union([z.number(), z.string().min(1)]).transform(String);
/** MT5: absent or 0 = no level. */
const level = z
  .number()
  .optional()
  .transform((v) => (v === undefined || v === 0 ? null : v));
const time = z.union([z.date(), z.string(), z.number()]).transform((v, ctx) => {
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) {
    ctx.addIssue({ code: "custom", message: "invalid time" });
    return z.NEVER;
  }
  return ms;
});

export const metaApiPosition = z
  .object({
    id,
    type: z.enum(["POSITION_TYPE_BUY", "POSITION_TYPE_SELL"]),
    symbol: z.string().min(1),
    magic: z.number().optional(),
    openPrice: z.number(),
    stopLoss: level,
    takeProfit: level,
    volume: z.number(),
    /**
     * MetaApi `profit` = open part EXCLUDING swap and commission + realized part including them (SDK 29.3.4 docs).
     * We want the open part, net: unrealizedProfit + unrealizedSwap + unrealizedCommission.
     */
    profit: z.number(),
    swap: z.number().optional(),
    commission: z.number().optional(),
    unrealizedProfit: z.number().optional(),
    unrealizedSwap: z.number().optional(),
    unrealizedCommission: z.number().optional(),
    comment: z.string().optional(),
    clientId: z.string().optional(),
  })
  .transform((p): Position => ({
    id: p.id,
    symbol: p.symbol,
    side: p.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL",
    volume: p.volume,
    openPrice: p.openPrice,
    sl: p.stopLoss,
    tp: p.takeProfit,
    // Rounded to cents: float noise like 7.999999999999999 or 1e-15 must not flip "in profit" (> 0) checks.
    profit: cents(
      p.unrealizedProfit === undefined
        ? p.profit + (p.swap ?? 0) + (p.commission ?? 0)
        : p.unrealizedProfit + (p.unrealizedSwap ?? 0) + (p.unrealizedCommission ?? 0),
    ),
    magic: p.magic ?? 0,
    ...(p.comment === undefined ? {} : { comment: p.comment }),
    ...(p.clientId === undefined || p.clientId === "" ? {} : { clientId: p.clientId }),
  }));

const PENDING_TYPES = {
  ORDER_TYPE_BUY_LIMIT: "BUY_LIMIT",
  ORDER_TYPE_BUY_STOP: "BUY_STOP",
  ORDER_TYPE_BUY_STOP_LIMIT: "BUY_STOP_LIMIT",
  ORDER_TYPE_SELL_LIMIT: "SELL_LIMIT",
  ORDER_TYPE_SELL_STOP: "SELL_STOP",
  ORDER_TYPE_SELL_STOP_LIMIT: "SELL_STOP_LIMIT",
} as const satisfies Record<string, PendingType>;

export const metaApiOrder = z
  .object({
    id,
    type: z.string(),
    symbol: z.string().min(1),
    magic: z.number().optional(),
    openPrice: z.number(),
    stopLoss: level,
    takeProfit: level,
    volume: z.number(),
    currentVolume: z.number().optional(),
    clientId: z.string().optional(),
  })
  .transform((o): PendingOrder | null => {
    // Market orders in flight and CLOSE_BY orders aren't pending orders we manage.
    const type = (PENDING_TYPES as Record<string, PendingType | undefined>)[o.type];
    if (type === undefined) return null;
    return {
      id: o.id,
      symbol: o.symbol,
      type,
      volume: o.currentVolume ?? o.volume,
      openPrice: o.openPrice,
      sl: o.stopLoss,
      tp: o.takeProfit,
      magic: o.magic ?? 0,
      ...(o.clientId === undefined || o.clientId === "" ? {} : { clientId: o.clientId }),
    };
  });

/** Market orders still being processed (ORDER_TYPE_BUY/SELL in the orders list): only what R6.5 needs. */
export const metaApiInFlight = z
  .object({ id, type: z.string(), clientId: z.string().optional() })
  .transform((o) =>
    (o.type === "ORDER_TYPE_BUY" || o.type === "ORDER_TYPE_SELL") &&
    o.clientId !== undefined &&
    o.clientId !== ""
      ? o.clientId
      : null,
  );

export const metaApiSpec = z
  .object({
    symbol: z.string().min(1),
    digits: z.number(),
    point: z.number(),
    tickSize: z.number(),
    stopsLevel: z.number(),
    freezeLevel: z.number(),
    minVolume: z.number(),
    maxVolume: z.number(),
    volumeStep: z.number(),
  })
  .transform((s): SymbolSpec => ({
    symbol: s.symbol,
    digits: s.digits,
    point: s.point,
    // Some feeds report tickSize 0 for FX: MT5 then uses the point.
    tickSize: s.tickSize > 0 ? s.tickSize : s.point,
    stopsLevel: s.stopsLevel,
    freezeLevel: s.freezeLevel,
    volumeMin: s.minVolume,
    volumeMax: s.maxVolume,
    volumeStep: s.volumeStep,
  }));

export const metaApiPrice = z
  .object({ symbol: z.string().min(1), bid: z.number(), ask: z.number(), time })
  .transform((q): Quote => ({ symbol: q.symbol, bid: q.bid, ask: q.ask, time: q.time }));

const MARGIN_MODES: Record<string, MarginMode> = {
  ACCOUNT_MARGIN_MODE_RETAIL_HEDGING: "HEDGING",
  ACCOUNT_MARGIN_MODE_RETAIL_NETTING: "NETTING",
  ACCOUNT_MARGIN_MODE_EXCHANGE: "EXCHANGE",
};

const TRADE_MODES: Record<string, AccountTradeMode> = {
  ACCOUNT_TRADE_MODE_DEMO: "DEMO",
  ACCOUNT_TRADE_MODE_CONTEST: "CONTEST",
  ACCOUNT_TRADE_MODE_REAL: "REAL",
};

export const metaApiAccount = z
  .object({
    currency: z.string(),
    balance: z.number(),
    equity: z.number(),
    margin: z.number(),
    freeMargin: z.number(),
    marginLevel: z.number().optional(),
    leverage: z.number(),
    marginMode: z.string().refine((m) => m in MARGIN_MODES, "unknown margin mode"),
    // An unknown account type is an error, never assumed to be demo.
    type: z.string().refine((t) => t in TRADE_MODES, "unknown account type"),
    tradeAllowed: z.boolean(),
  })
  .transform((a): AccountInfo => ({
    currency: a.currency,
    balance: a.balance,
    equity: a.equity,
    margin: a.margin,
    freeMargin: a.freeMargin,
    marginLevel: a.marginLevel === undefined || a.margin === 0 ? null : a.marginLevel,
    leverage: a.leverage,
    // refine above guarantees the key exists.
    marginMode: MARGIN_MODES[a.marginMode] ?? "EXCHANGE",
    // refine above guarantees the key exists; REAL is the safe fallback for type narrowing.
    tradeMode: TRADE_MODES[a.type] ?? "REAL",
    tradeAllowed: a.tradeAllowed,
  }));

const tradeResponse = z.object({
  numericCode: z.number().optional(),
  stringCode: z.string().optional(),
  message: z.string().optional(),
  orderId: id.optional(),
  positionId: id.optional(),
});

/** A MetaApi trade response or TradeError → one normalised TradeResult. */
export function toTradeResult(op: BrokerOp, raw: unknown, latencyMs: number): TradeResult {
  const r = tradeResponse.safeParse(raw);
  if (!r.success) {
    return {
      op,
      ok: false,
      class: classify(-4, op),
      code: -4,
      stringCode: "UNKNOWN_ERROR",
      message: "Unreadable broker response",
      latencyMs,
    };
  }
  const code =
    r.data.numericCode ?? (r.data.stringCode === undefined ? null : codeFromString(r.data.stringCode)) ?? -4;
  const cls = classify(code, op);
  return {
    op,
    ok: cls === "success",
    class: cls,
    code,
    stringCode: r.data.stringCode ?? codeName(code),
    message: r.data.message ?? "",
    latencyMs,
    ...(r.data.orderId === undefined ? {} : { orderId: r.data.orderId }),
    ...(r.data.positionId === undefined ? {} : { positionId: r.data.positionId }),
  };
}

/** Parse a list; one bad item fails the read with the item's index and field, never a silent drop. */
export function parseList<T>(schema: z.ZodType<T>, raw: unknown, what: string): T[] {
  if (!Array.isArray(raw)) throw new BrokerError("BAD_DATA", `${what}: expected a list`);
  return raw.map((item, i) => parseOne(schema, item, `${what}[${String(i)}]`));
}

export function parseOne<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  const where = first === undefined ? "" : `.${first.path.map(String).join(".")}`;
  throw new BrokerError("BAD_DATA", `${what}${where}: ${first?.message ?? "invalid"}`);
}
