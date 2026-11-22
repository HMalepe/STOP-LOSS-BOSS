/**
 * What the executor runs and what it reports (docs/04-API-SPEC SSE events).
 * Non-negotiable 6: partial failure is normal. Every item ends as done / failed / unknown / skipped, never "assumed done".
 */
import type { MarketOrderReq, PendingOrderReq } from "@/broker/BrokerProvider";
import type { BrokerOp } from "@/broker/retcodes";
import type { PlanItem } from "@/domain/types";

/** Plan items (modify/close/cancel) plus entries (Order Desk, Phase 08). */
export type ExecItem =
  | PlanItem
  | { readonly op: "market"; readonly req: MarketOrderReq }
  | { readonly op: "pending"; readonly req: PendingOrderReq };

/**
 * done    - the broker confirmed it (or it's already in the wanted state)
 * failed  - definitely not done; reason in `message`
 * unknown - may or may not have happened (ADR-0009): check manually, never retried automatically
 * skipped - never sent (aborted, or re-validation said it no longer applies)
 */
export type Outcome = "done" | "failed" | "unknown" | "skipped";

export interface ItemResult {
  readonly index: number;
  readonly op: BrokerOp;
  /** positionId, orderId, or clientId for entries. */
  readonly targetId: string;
  readonly outcome: Outcome;
  /** Last broker code (null if nothing was sent). */
  readonly code: number | null;
  readonly stringCode: string;
  readonly message: string;
  readonly attempts: number;
  /** Total time spent in broker calls for this item. */
  readonly latencyMs: number;
  readonly positionId?: string;
  readonly orderId?: string;
  /** R6.7: an entry that filled only partly. */
  readonly partial?: boolean;
}

export interface Progress {
  readonly total: number;
  readonly finished: number;
  readonly done: number;
  readonly failed: number;
  readonly unknown: number;
  readonly skipped: number;
}

export interface Summary extends Progress {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly retries: number;
  readonly aborted: boolean;
}

export type ExecEvent =
  | { readonly type: "item"; readonly item: ItemResult; readonly progress: Progress }
  | { readonly type: "complete"; readonly summary: Summary; readonly items: readonly ItemResult[] };

export function targetOf(item: ExecItem): string {
  switch (item.op) {
    case "modify":
    case "close":
      return item.positionId;
    case "cancel":
      return item.orderId;
    case "market":
    case "pending":
      return item.req.clientId;
  }
}
