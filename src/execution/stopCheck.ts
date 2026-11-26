/**
 * R5.3b: an entry counts as filled only when its stop is VERIFIED (non-negotiable 9: no entry without its requested stop).
 * After every successful entry (direct, settled late, or found by reconcile) the book is read. A stop that is absent or differs by more than
 * one tick is repaired at once (an urgent-lane modify, twice at most); if it can't be, the position is closed by ticket (a pending order is
 * cancelled) and the item FAILS, saying so. If even that fails, the item is `unknown` with a loud message: it is open without its stop.
 * Reads come from the terminal state (0 credits); only the repair, the close or the cancel spend credits.
 */
import type { BrokerProvider, TradeResult } from "@/broker/BrokerProvider";
import type { CreditLimiter } from "./rateLimiter";
import type { ExecItem, ItemResult } from "./types";

type EntryItem = Extract<ExecItem, { op: "market" | "pending" }>;

export interface StopCheckCtx {
  readonly broker: BrokerProvider;
  readonly limiter: CreditLimiter;
  readonly costPerTrade?: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Within one tick (a hair over, so float representation never flips a good stop to "wrong"). */
const sameLevel = (a: number | null, b: number, tick: number) =>
  a !== null && Math.abs(a - b) <= tick * 1.0001;

/** One credit-spending call on the urgent lane (safety repairs never queue behind a normal batch). */
async function spend(ctx: StopCheckCtx, call: () => Promise<TradeResult>): Promise<TradeResult> {
  const release = await ctx.limiter.acquire(ctx.costPerTrade ?? 10, "urgent");
  try {
    return await call();
  } finally {
    release();
  }
}

export async function verifyEntryStop(
  item: EntryItem,
  res: ItemResult,
  ctx: StopCheckCtx,
): Promise<ItemResult> {
  const want = item.req.sl;
  if (want === null) return res; // R9.2b: the owner chose no stop. Nothing was requested, nothing to verify.
  const isMarket = item.op === "market";
  const ticket = isMarket ? res.positionId : res.orderId;
  if (ticket === undefined) return res;

  let tick: number;
  const readStop = async (): Promise<number | null | undefined> => {
    // undefined = the entity isn't on the book (closed or triggered meanwhile): no naked exposure to guard.
    if (isMarket) return (await ctx.broker.getPositions()).find((p) => p.id === ticket)?.sl;
    return (await ctx.broker.getOrders()).find((o) => o.id === ticket)?.sl;
  };
  let current: number | null | undefined;
  try {
    tick = (await ctx.broker.getSymbolSpec(item.req.symbol)).tickSize;
    current = await readStop();
  } catch (e) {
    // Keep what we already knew (a partial fill, a late confirmation) and add that the stop is unverified.
    const warn = `its stop couldn't be verified (${errText(e)}): check it in MT5`;
    return {
      ...res,
      outcome: "unknown",
      message: res.message === "done" ? `placed, but ${warn}` : `${res.message}; but ${warn}`,
    };
  }
  if (current === undefined || sameLevel(current, want, tick)) return res;

  // A pending order can't be modified through the broker interface: it is cancelled (safe) rather than left to fill without its stop.
  if (isMarket) {
    const levels = { sl: want, tp: item.req.tp };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = await spend(ctx, () => ctx.broker.modifyPosition(ticket, levels));
      if (r.ok) {
        try {
          const now = await readStop();
          if (now === undefined || sameLevel(now, want, tick)) {
            return {
              ...res,
              message: "done (its stop was missing and has been set)",
              attempts: res.attempts,
            };
          }
        } catch {
          // fall through to the next attempt, then the close
        }
      }
    }
    const closed = await spend(ctx, () => ctx.broker.closePosition(ticket));
    return closed.ok || closed.code === 10036
      ? {
          ...res,
          outcome: "failed",
          message: "entry reverted: its stop could not be set, so the position was closed",
        }
      : {
          ...res,
          outcome: "unknown",
          message: "THIS POSITION IS OPEN WITHOUT ITS STOP and could not be closed: close it in MT5 now",
        };
  }
  const cancelled = await spend(ctx, () => ctx.broker.cancelOrder(ticket));
  return cancelled.ok
    ? {
        ...res,
        outcome: "failed",
        message: "entry reverted: the pending order had no stop, so it was cancelled",
      }
    : {
        ...res,
        outcome: "unknown",
        message: "THIS PENDING ORDER HAS NO STOP and could not be cancelled: cancel it in MT5 now",
      };
}
