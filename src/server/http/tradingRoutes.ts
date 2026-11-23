/** GET /api/state, GET /api/positions (docs/04). Later milestones add plans, execute, close-now, history. */
import { z } from "zod";
import { BrokerError } from "@/broker/BrokerProvider";
import { killSwitchState } from "@/server/killSwitch";
import { AccountModeError, type TradingServices } from "@/server/trading/services";
import { createPlan, LATER_ACTIONS, loadPlan, planBody } from "@/server/trading/plans";
import { loadState, pagePositions } from "@/server/trading/state";
import { auditKey, audit } from "@/server/audit/audit";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";
import { parseJson } from "./request";

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");

const stateQuery = z.object({ symbol: SYMBOL.optional() });
const positionsQuery = z.object({
  symbol: SYMBOL.optional(),
  side: z.enum(["ALL", "BUY", "SELL"]).default("ALL"),
  cursor: z.string().max(64).optional(),
});

function query<T>(
  req: Request,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; message: string } {
  const params = Object.fromEntries([...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""));
  const r = schema.safeParse(params);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    message: first === undefined ? "Invalid query." : `${first.path.join(".") || "query"}: ${first.message}`,
  };
}

/** Broker trouble is a 503 with a plain message, never stale data; a wrong account type is refused outright. */
export async function withBroker(
  services: () => Promise<TradingServices>,
  run: (svc: TradingServices) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(await services());
  } catch (e) {
    if (e instanceof AccountModeError) return fail("ACCOUNT_MODE_MISMATCH", e.message);
    if (e instanceof BrokerError) {
      return fail("BROKER_UNAVAILABLE", "The broker isn't answering right now. Nothing was sent.", {
        details: { kind: e.kind },
      });
    }
    throw e;
  }
}

const PLAN_INVALID_EMPTY = "Nothing to do: no open positions match.";

export function makeTradingRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
) {
  return {
    state: guard.authed({}, async ({ req, deps }) => {
      const q = query(req, stateQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      return withBroker(services, async (svc) =>
        ok(await loadState(svc, await killSwitchState(deps.db, svc.envHalted), q.value.symbol)),
      );
    }),

    positions: guard.authed({}, async ({ req }) => {
      const q = query(req, positionsQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      const { symbol, side, cursor } = q.value;
      return withBroker(services, async (svc) =>
        ok(
          pagePositions(
            await svc.broker.getPositions(),
            symbol === undefined ? { side } : { symbol, side },
            cursor,
          ),
        ),
      );
    }),

    /** POST /api/plans: a dry run. Nothing is sent to the broker; the plan is stored for 30 s. */
    createPlan: guard.authed({}, async ({ req, deps, session }) => {
      const raw = await parseJson(req, z.object({ action: z.string() }).loose());
      if (!raw.ok) return fail("VALIDATION", raw.message);
      if (LATER_ACTIONS.has(raw.value.action)) {
        return fail("VALIDATION", `"${raw.value.action}" arrives with the Order Desk. Not available yet.`);
      }
      const body = planBody.safeParse(raw.value);
      if (!body.success) {
        const first = body.error.issues[0];
        return fail(
          "VALIDATION",
          first === undefined
            ? "Invalid plan."
            : `${first.path.map(String).join(".") || "body"}: ${first.message}`,
        );
      }
      return withBroker(services, async (svc) => {
        const r = await createPlan(svc, deps.db, session.userId, body.data, (t, summary) =>
          audit(
            t,
            auditKey(deps.sessionSecret),
            {
              actor: "owner",
              action: "plan.created",
              subject: summary.id,
              details: { action: summary.action, symbol: summary.symbol, count: summary.count },
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
      });
    }),

    /** GET /api/plans/:id: the stored summary and its exact items. Only the owner's own plans. */
    getPlan: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const plan = await loadPlan(deps.db, session.userId, id);
        if (plan === null) return fail("NOT_FOUND", "No such plan.");
        const expired = plan.status === "created" && plan.expiresAt <= deps.clock.now();
        return ok({ ...plan.summary, status: expired ? "expired" : plan.status, items: plan.items });
      })(req),
  };
}
