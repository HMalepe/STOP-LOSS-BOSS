/** /api/presets/* : OD3/OD4. CRUD on recipes, and fire = a fresh preview through the normal path (R9.6, R9.7). */
import type { AuthDeps, Session } from "@/server/auth/login";
import {
  createPreset,
  deletePreset,
  getPreset,
  listPresets,
  presetInput,
  presetPatch,
  reorderBody,
  reorderPresets,
  updatePreset,
  type PresetResult,
} from "@/server/presets";
import { entryBody } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import type { makeGuard } from "./guard";
import { previewPlan } from "./previewPlan";
import { fail, ok } from "./respond";
import { parseJson } from "./request";
import { SessionLimiter, type Budget } from "./sessionLimiter";
import { withBroker } from "./tradingRoutes";

const asResponse = <T>(r: PresetResult<T>, status: number, body: (v: T) => unknown): Response =>
  r.ok ? ok(body(r.value), status) : fail(r.code, r.message);

export function makePresetRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
  limiter?: SessionLimiter,
) {
  let lim = limiter;
  const throttle = (deps: AuthDeps, session: Session, budget: Budget): Response | null => {
    lim ??= new SessionLimiter(deps.clock);
    const wait = lim.take(session.idHash, budget);
    return wait === 0
      ? null
      : fail("RATE_LIMITED", "Slow down a moment.", {
          headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
        });
  };

  return {
    list: guard.authed({}, async ({ deps, session }) => {
      const limited = throttle(deps, session, "read");
      if (limited !== null) return limited;
      return ok({ presets: await listPresets(deps.db, session.userId) });
    }),

    create: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "plan");
      if (limited !== null) return limited;
      const body = await parseJson(req, presetInput);
      if (!body.ok) return fail("VALIDATION", body.message);
      return asResponse(await createPreset(deps, session.userId, body.value), 201, (p) => p);
    }),

    update: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        const body = await parseJson(req, presetPatch);
        if (!body.ok) return fail("VALIDATION", body.message);
        return asResponse(await updatePreset(deps, session.userId, id, body.value), 200, (p) => p);
      })(req),

    remove: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        return asResponse(await deletePreset(deps, session.userId, id), 200, () => ({ deleted: true }));
      })(req),

    reorder: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "plan");
      if (limited !== null) return limited;
      const body = await parseJson(req, reorderBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      const r = await reorderPresets(deps, session.userId, body.value.ids);
      return r.ok ? ok({ presets: await listPresets(deps.db, session.userId) }) : fail(r.code, r.message);
    }),

    /**
     * POST /api/presets/:id/fire → 201 plan summary, exactly like POST /api/plans. Nothing is sent to the broker; the
     * owner confirms and executes the stored plan as usual. The recipe is re-parsed with today's rules (it may have
     * been saved before they changed) and priced from the live quote and spec, never from when it was saved.
     */
    fire: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        const preset = await getPreset(deps.db, session.userId, id);
        if (preset === null) return fail("NOT_FOUND", "No such preset.");
        const recipe = entryBody.safeParse(preset.recipe);
        if (!recipe.success) {
          const first = recipe.error.issues[0];
          return fail(
            "VALIDATION",
            `This preset is no longer valid (${first === undefined ? "bad recipe" : `${first.path.map(String).join(".") || "recipe"}: ${first.message}`}). Edit or delete it.`,
          );
        }
        return withBroker(services, (svc) => previewPlan(svc, deps, session.userId, recipe.data, preset.id));
      })(req),
  };
}
