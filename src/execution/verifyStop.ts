/**
 * R5.3b: an entry counts as filled only when its stop is verified on the open position.
 *
 * After a market entry is reported done (directly, settled late, or confirmed by reconcile), read the position and
 * compare its SL with the one requested (within one tick):
 *   - matches            → done.
 *   - absent / off       → set it NOW (both levels, ADR-0008), up to 2 tries.
 *   - can't be set       → close the position by ticket and report "entry reverted: stop could not be set".
 *   - can't be closed    → UNKNOWN with a loud message: a naked position is open (the alert fires on unknown).
 *   - can't see/verify   → UNKNOWN: filled, but its stop is unverified. Never a plain "done".
 * These follow-ups use the urgent lane and ignore the abort signal: a position without its stop must never be left
 * behind because a batch was stopped half way. No stop requested (noStop) → nothing to verify.
 */
import type { MarketOrderReq, TradeResult } from "@/broker/BrokerProvider";
import type { Price } from "@/domain/types";
import { send } from "./executor";
import type { RunContext } from "./retries";
import type { ItemResult } from "./types";

const FIX_TRIES = 2;
const CLOSE_TRIES = 2;

export async function verifyEntryStop(
  req: MarketOrderReq,
  res: ItemResult,
  ctx: RunContext,
): Promise<ItemResult> {
  if (req.sl === null) return res; // noStop: nothing was requested, nothing to verify
  const positionId = res.positionId;
  const unverified = (why: string): ItemResult => ({
    ...res,
    outcome: "unknown",
    message: `filled, but its stop could not be verified (${why}): check position ${positionId ?? "?"} in MT5 now`,
  });
  if (positionId === undefined) return unverified("no ticket came back");

  let tick: number;
  try {
    tick = (await ctx.broker.getSymbolSpec(req.symbol)).tickSize;
  } catch {
    return unverified("symbol spec unavailable");
  }

  // The stream can lag a fill by a moment: poll like reconcile does before giving up.
  let sl: number | null | undefined;
  for (let poll = 0; poll < Math.max(1, ctx.policy.reconcilePolls); poll++) {
    if (poll > 0) await ctx.scheduler.sleep(ctx.policy.reconcileIntervalMs);
    try {
      const pos = (await ctx.broker.getPositions()).find((p) => p.id === positionId);
      if (pos !== undefined) {
        sl = pos.sl;
        break;
      }
    } catch {
      // try again
    }
  }
  if (sl === undefined) return unverified("position not visible yet");
  // Within one tick (plus float noise) counts as matching.
  if (sl !== null && Math.abs(sl - req.sl) <= tick * 1.000001) return res;

  let latency = res.latencyMs;
  let attempts = res.attempts;
  const call = async (item: Parameters<typeof send>[1]): Promise<TradeResult | null> => {
    let release: (() => void) | undefined;
    try {
      release = await ctx.limiter.acquire(ctx.costPerTrade ?? 10, "urgent");
      const r = await send(ctx.broker, item);
      attempts += 1;
      latency += r.latencyMs;
      ctx.breaker?.record(r);
      try {
        ctx.onCall?.({ index: res.index, op: item.op, targetId: positionId, attempt: attempts, result: r });
      } catch {
        // logging never changes a trade
      }
      return r;
    } catch {
      return null;
    } finally {
      release?.();
    }
  };
  const done = (r: ItemResult): ItemResult => ({ ...r, attempts, latencyMs: latency });

  for (let i = 0; i < FIX_TRIES; i++) {
    const r = await call({
      op: "modify",
      positionId,
      side: req.side,
      sl: req.sl as Price,
      tp: req.tp as Price | null,
      before: { sl: null, tp: null },
    });
    if (r?.class === "success") {
      return done({
        ...res,
        message: "placed; its stop was missing after the fill and has been set (R5.3b)",
      });
    }
  }
  for (let i = 0; i < CLOSE_TRIES; i++) {
    const r = await call({ op: "close", positionId, side: req.side, volume: req.volume });
    if (r?.class === "success") {
      return done({ ...res, outcome: "failed", message: "entry reverted: stop could not be set" });
    }
  }
  return done({
    ...res,
    outcome: "unknown",
    message: `filled with NO STOP and it could not be closed: close it in MT5 NOW (position ${positionId})`,
  });
}
