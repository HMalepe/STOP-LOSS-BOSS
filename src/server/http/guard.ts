/**
 * The one wrapper every API route goes through (docs/05):
 * - Origin check on every non-GET (CSRF): Origin must equal APP_ORIGIN (or, in mock mode with none set, the request's own
 *   origin). Missing Origin on a POST, or Sec-Fetch-Site: cross-site, is refused. SameSite=Strict cookies are the first line;
 *   this is the second.
 * - Session required unless `public`. `reauth` requires a TOTP within the last 5 minutes.
 * - Unexpected errors become a generic 500: the details go to the (secret-scrubbed) log, never to the client.
 */
import type { Logger } from "pino";
import { SESSION_COOKIE } from "@/server/auth/cookies";
import { hasFreshReauth, validateSession, type AuthDeps, type Session } from "@/server/auth/login";
import { fail } from "./respond";
import { readCookie } from "./request";

export interface GuardEnv {
  readonly appOrigin: string | undefined;
}

export interface RouteContext {
  readonly req: Request;
  readonly deps: AuthDeps;
  readonly session: Session;
}

export interface PublicContext {
  readonly req: Request;
  readonly deps: AuthDeps;
}

export function originAllowed(req: Request, appOrigin: string | undefined): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  const expected = appOrigin ?? new URL(req.url).origin;
  return origin === expected;
}

export function makeGuard(
  deps: () => Promise<AuthDeps>,
  env: () => GuardEnv,
  log?: () => Pick<Logger, "error">,
) {
  const safely = async (run: () => Promise<Response>): Promise<Response> => {
    try {
      return await run();
    } catch (e) {
      log?.().error({ err: e }, "api error");
      return fail("INTERNAL", "Something went wrong. Nothing was sent to the broker by this request.");
    }
  };

  return {
    /** No session needed (login itself), but the origin check still applies to POSTs. */
    open(handler: (ctx: PublicContext) => Promise<Response>) {
      return (req: Request): Promise<Response> =>
        safely(async () => {
          if (!originAllowed(req, env().appOrigin)) return fail("FORBIDDEN_ORIGIN", "Request refused.");
          return handler({ req, deps: await deps() });
        });
    },

    /** Session required; `reauth` = a fresh TOTP (last 5 min) required too. */
    authed(opts: { readonly reauth?: boolean }, handler: (ctx: RouteContext) => Promise<Response>) {
      return (req: Request): Promise<Response> =>
        safely(async () => {
          if (!originAllowed(req, env().appOrigin)) return fail("FORBIDDEN_ORIGIN", "Request refused.");
          const d = await deps();
          const session = await validateSession(d, readCookie(req, SESSION_COOKIE));
          if (session === null) return fail("UNAUTHENTICATED", "Sign in first.");
          if (opts.reauth === true && !hasFreshReauth(session, d.clock.now())) {
            return fail("REAUTH_REQUIRED", "Enter a fresh code from your authenticator to do this.");
          }
          return handler({ req, deps: d, session });
        });
    },
  };
}
