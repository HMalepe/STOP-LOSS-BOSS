/** One mapping from a plan builder's refusal to the HTTP error, shared by preview and preset fire so they can never disagree. */
import type { PlanError } from "@/domain/plan";
import { fail } from "./respond";

export type PlanRefusal = PlanError | { readonly code: "PRICE_STALE"; readonly message: string };

export function planErrorResponse(e: PlanRefusal): Response {
  switch (e.code) {
    case "VALIDATION":
      return fail("VALIDATION", e.message);
    case "PRICE_STALE":
      return fail("PRICE_STALE", e.message);
    case "BROKER_UNAVAILABLE":
      return fail("BROKER_UNAVAILABLE", e.message, { details: e.details });
    case "NO_MATCH":
      return fail("PLAN_INVALID", "Nothing to do: no open positions match.", { details: [] });
    case "PLAN_INVALID":
      return fail("PLAN_INVALID", e.message, { details: e.details });
  }
}
