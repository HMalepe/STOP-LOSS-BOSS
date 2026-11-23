/** /api/admin/* : the kill switch and live enablement (docs/04, docs/05). */
import { z } from "zod";
import { audit, auditKey } from "@/server/audit/audit";
import { SESSION_COOKIE, clearCookie } from "@/server/auth/cookies";
import { hasFreshReauth, revokeAllSessions } from "@/server/auth/login";
import { killSwitchState, setKillSwitch } from "@/server/killSwitch";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";
import { parseJson } from "./request";

export const killBody = z.object({ halted: z.boolean() });
export const liveBody = z.object({ accountId: z.uuid(), enabled: z.boolean() });

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
      await setKillSwitch(deps, body.value.halted, session);
      return ok(await killSwitchState(deps.db, envHalted()));
    }),

    /** Live is opt-in twice: this flag AND TRADING_MODE=live. ON needs re-auth; OFF doesn't. */
    liveEnabled: guard.authed({}, async ({ req, deps, session }) => {
      const body = await parseJson(req, liveBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      if (body.value.enabled && !hasFreshReauth(session, deps.clock.now())) {
        return fail("REAUTH_REQUIRED", REAUTH);
      }
      const found = await deps.db.tx(async (t) => {
        const rows = await t.query<{ id: string }>(
          "update accounts set live_enabled = $1 where id = $2 returning id",
          [body.value.enabled, body.value.accountId],
        );
        if (rows.length === 0) return false;
        await audit(
          t,
          auditKey(deps.sessionSecret),
          {
            actor: "owner",
            action: body.value.enabled ? "live.enabled" : "live.disabled",
            subject: body.value.accountId,
          },
          new Date(deps.clock.now()),
        );
        return true;
      });
      if (!found) return fail("NOT_FOUND", "No such account.");
      return ok({ accountId: body.value.accountId, liveEnabled: body.value.enabled });
    }),

    /**
     * "Sign out everywhere" (incident response: a phone lost, a cookie leaked). Re-auth gated so a stolen cookie alone
     * can't use it to lock the owner out. Revokes this session too, so the cookie is cleared.
     */
    revokeAllSessions: guard.authed({ reauth: true }, async ({ deps, session, ip }) => {
      const revoked = await revokeAllSessions(deps, session, ip);
      return ok({ revoked }, 200, { "Set-Cookie": clearCookie(SESSION_COOKIE) });
    }),
  };
}
