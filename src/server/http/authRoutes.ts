/**
 * /api/auth/* (04-API-SPEC). Built from a deps provider so tests run the real handlers against a real (embedded) database.
 * Route files in src/app/api/auth just re-export these.
 */
import { z } from "zod";
import { PENDING_COOKIE, SESSION_COOKIE, clearCookie, setCookie } from "@/server/auth/cookies";
import {
  hasFreshReauth,
  LIMITS,
  logout,
  passwordStep,
  reauth,
  secondFactorStep,
  validateSession,
  type AuthDeps,
  type AuthError,
} from "@/server/auth/login";
import { fail, ok } from "./respond";
import { clientIp, parseJson, readCookie } from "./request";

export const loginBody = z.object({ password: z.string().min(1).max(512) });
export const codeBody = z.object({ code: z.string().min(1).max(64) });

function authError(e: AuthError): Response {
  return e.code === "RATE_LIMITED"
    ? fail("RATE_LIMITED", e.message, {
        headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) },
      })
    : fail("UNAUTHENTICATED", e.message);
}

export function makeAuthRoutes(deps: () => Promise<AuthDeps>) {
  return {
    async login(req: Request, ip = clientIp(req)): Promise<Response> {
      const body = await parseJson(req, loginBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      const r = await passwordStep(await deps(), { password: body.value.password, ip });
      if (!r.ok) return authError(r);
      return ok({ needsTotp: true }, 200, {
        "Set-Cookie": setCookie(PENDING_COOKIE, r.pendingToken, LIMITS.pendingTtlMs / 1000),
      });
    },

    async totp(req: Request, ip = clientIp(req)): Promise<Response> {
      const body = await parseJson(req, codeBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      const pendingToken = readCookie(req, PENDING_COOKIE);
      if (pendingToken === undefined) return fail("UNAUTHENTICATED", "Enter your password first.");
      const d = await deps();
      const r = await secondFactorStep(d, {
        pendingToken,
        code: body.value.code,
        ip,
        userAgent: req.headers.get("user-agent") ?? "",
      });
      if (!r.ok) return authError(r);
      const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
      headers.append(
        "Set-Cookie",
        setCookie(SESSION_COOKIE, r.sessionToken, (r.absoluteExpiresAt - d.clock.now()) / 1000),
      );
      headers.append("Set-Cookie", clearCookie(PENDING_COOKIE));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    },

    async logout(req: Request): Promise<Response> {
      await logout(await deps(), readCookie(req, SESSION_COOKIE));
      return new Response(null, {
        status: 204,
        headers: { "Set-Cookie": clearCookie(SESSION_COOKIE), "Cache-Control": "no-store" },
      });
    },

    async reauth(req: Request, ip = clientIp(req)): Promise<Response> {
      const body = await parseJson(req, codeBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      const d = await deps();
      const session = await validateSession(d, readCookie(req, SESSION_COOKIE));
      if (session === null) return fail("UNAUTHENTICATED", "Sign in first.");
      const r = await reauth(d, session, body.value.code, ip);
      return r.ok ? ok({ ok: true }) : authError(r);
    },

    async session(req: Request): Promise<Response> {
      const d = await deps();
      const s = await validateSession(d, readCookie(req, SESSION_COOKIE));
      if (s === null) return ok({ authenticated: false });
      return ok({
        authenticated: true,
        reauthFresh: hasFreshReauth(s, d.clock.now()),
        expiresAt: new Date(s.absoluteExpiresAt).toISOString(),
      });
    },
  };
}
