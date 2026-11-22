/**
 * R6.3: before re-sending a modify, re-check it against fresh state with the same domain rules the preview used.
 * Reads come from the stream (0 credits). Also catches R7.1's worst case: a level the plan leaves as "none" that the owner set
 * elsewhere since the preview would be wiped by the resend, so the item is skipped instead.
 */
import type { BrokerProvider } from "@/broker/BrokerProvider";
import { specProblems, toPoints } from "@/domain/price";
import { decideModify, marketFrom, quoteProblems, DEFAULT_BUFFER_POINTS } from "@/domain/rules";
import type { Revalidate } from "./retries";

export function makeRevalidator(
  broker: BrokerProvider,
  bufferPoints: number = DEFAULT_BUFFER_POINTS,
): Revalidate {
  return async (item) => {
    const pos = (await broker.getPositions()).find((p) => p.id === item.positionId);
    if (pos === undefined) return { ok: false, reason: "position is already closed" };
    if (item.sl === null && pos.sl !== null) {
      return { ok: false, reason: "SL was set elsewhere since the preview: re-preview" };
    }
    if (item.tp === null && pos.tp !== null) {
      return { ok: false, reason: "TP was set elsewhere since the preview: re-preview" };
    }

    const [spec, quote] = await Promise.all([broker.getSymbolSpec(pos.symbol), broker.getQuote(pos.symbol)]);
    if (specProblems(spec).length > 0 || quoteProblems(quote).length > 0) {
      return { ok: false, reason: "broker data unusable for re-validation" };
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
