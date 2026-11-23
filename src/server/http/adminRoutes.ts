/** /api/admin/* : the kill switch and live enablement (docs/04, docs/05). */
import { z } from "zod";
import { audit } from "@/server/audit/audit";
import { hasFreshReauth } from "@/server/auth/login";
import { killSwitchState, setKillSwitch } from "@/server/killSwitch";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";
import { parseJson } from "./request";

const killBody = z.object({ halted: z.boolean() });
const liveBody = z.object({ accountId: z.uuid(), enabled: z.boolean() });

const REAUTH = "Enter a fresh code from your authenticator to do this.";

export function makeAdminRoutes(guard: ReturnType<typeof makeGuard>, envHalted: () => boolean) {
  return {
    killSwitchGet: guard.authed({}, async ({ deps }) => ok(await killSwitchState(deps.db, envHalted()))),

    /** ON: always allowed (getting safe must be instant). OFF: the sensitive direction, re-auth required. */
    killSwitchSet: guard.authed({}, async ({ req, deps, session }) => {
      const body = await parseJson(req, killBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      if (!body.value.halted && !hasFreshReauth(session, deps.clock.now())) {
        return fail("REAUTH_REQUIRED", REAUTH);
      }
      await setKillSwitch(deps.db, body.value.halted, session);
      return ok(await killSwitchState(deps.db, envHalted()));
    }),

    /** Live is opt-in twice: this flag AND TRADING_MODE=live. ON needs re-auth; OFF doesn't. */
    liveEnabled: guard.authed({}, async ({ req, deps, session }) => {
      const body = await parseJson(req, liveBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      if (body.value.enabled && !hasFreshReauth(session, deps.clock.now())) {
        return fail("REAUTH_REQUIRED", REAUTH);
      }
      const rows = await deps.db.query<{ id: string }>(
        "update accounts set live_enabled = $1 where id = $2 returning id",
        [body.value.enabled, body.value.accountId],
      );
      if (rows.length === 0) return fail("NOT_FOUND", "No such account.");
      await audit(deps.db, {
        actor: "owner",
        action: body.value.enabled ? "live.enabled" : "live.disabled",
        subject: body.value.accountId,
      });
      return ok({ accountId: body.value.accountId, liveEnabled: body.value.enabled });
    }),
  };
}
