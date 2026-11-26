/** /api/presets (docs/11 OD3, OD4): CRUD plus fire. Fire only BUILDS a plan (R9.6): the owner still previews and confirms it. */
import { audit, auditKey } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import {
  createPreset,
  deletePreset,
  getPreset,
  listPresets,
  presetCreate,
  presetFire,
  presetUpdate,
  resolveRecipe,
  updatePreset,
} from "@/server/trading/presets";
import { createEntryPlan } from "@/server/trading/entryPlans";
import type { TradingServices } from "@/server/trading/services";
import type { makeGuard } from "./guard";
import { planErrorResponse } from "./planErrors";
import { parseJson } from "./request";
import { fail, ok } from "./respond";
import { makeThrottle, type SessionLimiter } from "./sessionLimiter";
import { withBroker } from "./tradingRoutes";

const NAME_TAKEN = "You already have a preset with that name.";
const TOO_MANY = "That's the limit for saved presets. Delete one first.";

export function makePresetRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
  limiter?: SessionLimiter,
) {
  const throttle = makeThrottle(limiter);
  const log = (
    deps: { sessionSecret: string; clock: { now(): number } },
    db: Db,
    action: string,
    subject: string,
    details: Record<string, unknown>,
  ) =>
    audit(
      db,
      auditKey(deps.sessionSecret),
      { actor: "owner", action, subject, details },
      new Date(deps.clock.now()),
    );

  return {
    list: guard.authed({}, async ({ deps, session }) => {
      const limited = throttle(deps, session, "read");
      if (limited !== null) return limited;
      return ok({ items: await listPresets(deps.db, session.userId) });
    }),

    create: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "plan");
      if (limited !== null) return limited;
      const body = await parseJson(req, presetCreate);
      if (!body.ok) return fail("VALIDATION", body.message);
      const at = new Date(deps.clock.now());
      const r = await createPreset(deps.db, session.userId, body.value, at, (t, id) =>
        log(deps, t, "preset.created", id, { name: body.value.name, kind: body.value.recipe.kind }),
      );
      if (r.ok) return ok(r.preset, 201);
      return fail("VALIDATION", r.code === "NAME_TAKEN" ? NAME_TAKEN : TOO_MANY);
    }),

    update: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        const body = await parseJson(req, presetUpdate);
        if (!body.ok) return fail("VALIDATION", body.message);
        const r = await updatePreset(
          deps.db,
          session.userId,
          id,
          body.value,
          new Date(deps.clock.now()),
          (t) => log(deps, t, "preset.updated", id, { fields: Object.keys(body.value) }),
        );
        if (r.ok) return ok(r.preset);
        return r.code === "NOT_FOUND" ? fail("NOT_FOUND", "No such preset.") : fail("VALIDATION", NAME_TAKEN);
      })(req),

    remove: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        const gone = await deletePreset(deps.db, session.userId, id, (t, name) =>
          log(deps, t, "preset.deleted", id, { name }),
        );
        return gone ? ok({ deleted: true }) : fail("NOT_FOUND", "No such preset.");
      })(req),

    /** POST /api/presets/:id/fire → 201 PlanSummary, built from the LIVE quote and spec. Same preview → confirm → execute from here. */
    fire: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        const body = await parseJson(req, presetFire);
        if (!body.ok) return fail("VALIDATION", body.message);
        const preset = await getPreset(deps.db, session.userId, id);
        if (preset === null) return fail("NOT_FOUND", "No such preset.");
        if (body.value.side !== undefined && preset.recipe.kind !== "market") {
          return fail(
            "VALIDATION",
            "The side toggle only applies to market presets. A ladder's side is its order type.",
          );
        }
        return withBroker(services, async (svc) => {
          const symbol = preset.recipe.symbol;
          const [quote, spec] = await Promise.all([svc.broker.getQuote(symbol), svc.specs.get(symbol)]);
          const plan = resolveRecipe(preset.recipe, quote, spec, body.value.side);
          const r = await createEntryPlan(svc, deps.db, session.userId, plan, (t, summary) =>
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
                  batchSeq: summary.entry?.batchSeq ?? null,
                  preset: preset.name,
                  presetId: preset.id,
                },
              },
              new Date(svc.clock.now()),
            ),
          );
          return r.ok ? ok(r.summary, 201) : planErrorResponse(r.error);
        });
      })(req),
  };
}
