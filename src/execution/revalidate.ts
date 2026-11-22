/**
 * R6.3 / R7.1 / R7.2: before re-sending a modify, re-check it against fresh state with the same domain rules the preview used.
 * Reads come from the stream (0 credits).
 * - R7.1: if EITHER level on the live position differs from what the preview saw (`item.before`), the owner changed it
 *   elsewhere: skip, never overwrite it.
 * - R7.2: a quote older than maxQuoteAgeMs can't validate anything.
 */
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { Clock } from "@/domain/clock";
import { specProblems, toPoints } from "@/domain/price";
import { decideModify, DEFAULT_BUFFER_POINTS, marketFrom, quoteProblems } from "@/domain/rules";
import type { Revalidate } from "./retries";

export interface RevalidatorOptions {
  readonly clock: Clock;
  readonly bufferPoints?: number;
  /** R7.2 (default 3 s). */
  readonly maxQuoteAgeMs?: number;
}

export function makeRevalidator(broker: BrokerProvider, opts: RevalidatorOptions): Revalidate {
  const bufferPoints = opts.bufferPoints ?? DEFAULT_BUFFER_POINTS;
  const maxAge = opts.maxQuoteAgeMs ?? 3_000;
  return async (item) => {
    const pos = (await broker.getPositions()).find((p) => p.id === item.positionId);
    if (pos === undefined) return { ok: false, reason: "position is already closed" };

    const [spec, quote] = await Promise.all([broker.getSymbolSpec(pos.symbol), broker.getQuote(pos.symbol)]);
    if (specProblems(spec).length > 0 || quoteProblems(quote).length > 0) {
      return { ok: false, reason: "broker data unusable for re-validation" };
    }
    const same = (a: number | null, b: number | null) =>
      a === null || b === null ? a === b : toPoints(a, spec) === toPoints(b, spec);
    if (!same(pos.sl, item.before.sl) || !same(pos.tp, item.before.tp)) {
      return {
        ok: false,
        skip: true,
        reason: "changed elsewhere since the preview (R7.1): not touched, re-preview",
      };
    }
    if (opts.clock.now() - quote.time > maxAge) {
      return { ok: false, reason: `PRICE_STALE: the latest quote is older than ${String(maxAge)} ms (R7.2)` };
    }
    const m = marketFrom(spec, quote, bufferPoints);
    const decision = decideModify(
      pos,
      {
        ...(item.sl === null ? {} : { sl: toPoints(item.sl, spec) }),
        ...(item.tp === null ? {} : { tp: toPoints(item.tp, spec) }),
      },
      m,
    );
    switch (decision.kind) {
      case "modify":
        return { ok: true };
      case "skip":
        return decision.rule === "R2.8"
          ? { ok: false, alreadyDone: true, reason: "already at these levels" }
          : { ok: false, reason: `frozen: ${decision.frozen.level} is within the freeze level` };
      case "invalid":
        return {
          ok: false,
          reason: `price moved, level no longer valid (${decision.violations.map((v) => `${v.rule} ${v.side} ${v.level}`).join(", ")}): re-preview`,
        };
    }
  };
}
