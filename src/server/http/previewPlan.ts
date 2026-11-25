/**
 * One preview path for everything that creates a plan (docs/04 POST /api/plans, and firing a preset, R9.6/R9.7):
 * the same builder, the same stored plan, the same audit row, the same error mapping. A preset has no side door.
 */
import { audit, auditKey } from "@/server/audit/audit";
import type { AuthDeps } from "@/server/auth/login";
import { createPlan, type PlanBody } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import { fail, ok } from "./respond";

export const PLAN_INVALID_EMPTY = "Nothing to do: no open positions match.";

export async function previewPlan(
  svc: TradingServices,
  deps: AuthDeps,
  userId: string,
  body: PlanBody,
  /** Set when the plan was built from a preset, so the audit trail says which. */
  presetId?: string,
): Promise<Response> {
  const r = await createPlan(svc, deps.db, userId, body, (t, summary) =>
    audit(
      t,
      auditKey(deps.sessionSecret),
      {
        actor: "owner",
        action: "plan.created",
        subject: summary.id,
        details: {
          action: summary.action,
          symbol: summary.symbol,
          count: summary.count,
          ...(presetId === undefined ? {} : { presetId }),
        },
      },
      new Date(svc.clock.now()),
    ),
  );
  if (r.ok) return ok(r.summary, 201);
  const e = r.error;
  switch (e.code) {
    case "VALIDATION":
      return fail("VALIDATION", e.message);
    case "PRICE_STALE":
      return fail("PRICE_STALE", e.message);
    case "BROKER_UNAVAILABLE":
      return fail("BROKER_UNAVAILABLE", e.message, { details: e.details });
    case "NO_MATCH":
      return fail("PLAN_INVALID", PLAN_INVALID_EMPTY, { details: [] });
    case "PLAN_INVALID":
      return fail("PLAN_INVALID", e.message, { details: e.details });
  }
}
