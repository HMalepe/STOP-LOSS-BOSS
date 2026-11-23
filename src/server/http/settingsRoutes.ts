/** /api/settings/* : trading caps (docs/05: DB config, re-auth to change). */
import { capsPatchBody, effectiveCaps, overCeiling, setCaps, type Caps } from "@/server/caps";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";
import { parseJson } from "./request";

export function makeSettingsRoutes(guard: ReturnType<typeof makeGuard>, ceilings: () => Caps) {
  return {
    capsGet: guard.authed({}, async ({ deps }) => {
      const c = ceilings();
      return ok({ caps: await effectiveCaps(deps.db, c), ceilings: c });
    }),

    /** Any change needs a fresh authenticator code, lowering included (docs/05 says "change caps"). */
    capsSet: guard.authed({ reauth: true }, async ({ req, deps, session }) => {
      const body = await parseJson(req, capsPatchBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      const c = ceilings();
      const over = overCeiling(body.value, c);
      if (over !== null) return fail("VALIDATION", over);
      return ok({ caps: await setCaps(deps, c, body.value, session), ceilings: c });
    }),
  };
}
