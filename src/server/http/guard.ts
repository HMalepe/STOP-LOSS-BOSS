/**
 * The one wrapper every API route goes through (docs/05):
 * - Origin check on every non-GET (CSRF): Origin must equal APP_ORIGIN. With none set (mock mode only: demo/live require
 *   it), the request's own origin, and only on loopback, so a DNS-rebinding page can't borrow it. Missing Origin on a POST,
 *   or Sec-Fetch-Site: cross-site, is refused.
 * - The client IP comes from the one trusted header (TRUSTED_IP_HEADER) and is handed to handlers: nobody re-parses it. SameSite=Strict cookies are the first line;
 *   this is the second.
 * - Session required unless `public`. `reauth` requires a TOTP within the last 5 minutes.
 * - Unexpected errors become a generic 500: the details go to the (secret-scrubbed) log, never to the client.
 */
import type { Logger } from "pino";
import { PENDING_COOKIE, SESSION_COOKIE } from "@/server/auth/cookies";
import { hasFreshReauth, validateSession, type AuthDeps, type Session } from "@/server/auth/login";
import { fail } from "./respond";
import { clientIp, readCookie, type TrustedIpHeader } from "./request";

export interface GuardEnv {
  readonly appOrigin: string | undefined;
  readonly ipHeader?: TrustedIpHeader;
}

export interface RouteContext {
  readonly req: Request;
  readonly deps: AuthDeps;
  readonly session: Session;
  readonly ip: string;
}

export interface PublicContext {
  readonly req: Request;
  readonly deps: AuthDeps;
  readonly ip: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function originAllowed(req: Request, appOrigin: string | undefined): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  if (appOrigin !== undefined) return origin === appOrigin;
  const own = new URL(req.url);
  return LOOPBACK.has(own.hostname) && origin === own.origin;
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
          const e = env();
          if (!originAllowed(req, e.appOrigin)) return fail("FORBIDDEN_ORIGIN", "Request refused.");
          return handler({ req, deps: await deps(), ip: clientIp(req, e.ipHeader) });
        });
    },

    /** Session required; `reauth` = a fresh TOTP (last 5 min) required too. */
    authed(opts: { readonly reauth?: boolean }, handler: (ctx: RouteContext) => Promise<Response>) {
      return (req: Request): Promise<Response> =>
        safely(async () => {
          const e = env();
          if (!originAllowed(req, e.appOrigin)) return fail("FORBIDDEN_ORIGIN", "Request refused.");
          const d = await deps();
          const session = await validateSession(d, readCookie(req, SESSION_COOKIE));
          if (session === null) {
            // Password done, code not yet: say so, so the app goes straight to the code screen.
            return readCookie(req, PENDING_COOKIE) === undefined
              ? fail("UNAUTHENTICATED", "Sign in first.")
              : fail("TOTP_REQUIRED", "Enter the code from your authenticator.");
          }
          if (opts.reauth === true && !hasFreshReauth(session, d.clock.now())) {
            return fail("REAUTH_REQUIRED", "Enter a fresh code from your authenticator to do this.");
          }
          return handler({ req, deps: d, session, ip: clientIp(req, e.ipHeader) });
        });
    },
  };
}
