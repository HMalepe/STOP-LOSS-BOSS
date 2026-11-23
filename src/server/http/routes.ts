/** The route handlers wired to the real process services. Route files import from here. */
import { getAuthDeps } from "@/server/context";
import { getEnv } from "@/server/env";
import { getLogger } from "@/server/logger";
import { makeAdminRoutes } from "./adminRoutes";
import { makeAuthRoutes } from "./authRoutes";
import { makeGuard } from "./guard";

export const guard = makeGuard(getAuthDeps, () => ({ appOrigin: getEnv().APP_ORIGIN }), getLogger);

const auth = makeAuthRoutes(getAuthDeps);
/** Auth routes have no session yet, but still go through the origin check (login CSRF). */
export const authRoutes = {
  login: guard.open(({ req }) => auth.login(req)),
  totp: guard.open(({ req }) => auth.totp(req)),
  logout: guard.open(({ req }) => auth.logout(req)),
  reauth: guard.open(({ req }) => auth.reauth(req)),
  session: guard.open(({ req }) => auth.session(req)),
};

export const adminRoutes = makeAdminRoutes(guard, () => getEnv().TRADING_HALTED);
