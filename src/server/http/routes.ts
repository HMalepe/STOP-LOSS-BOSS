/** The route handlers wired to the real process services. Route files import from here. */
import { getAuthDeps } from "@/server/context";
import { capsFromEnv } from "@/server/caps";
import { getEnv } from "@/server/env";
import { getLogger } from "@/server/logger";
import { makeAdminRoutes } from "./adminRoutes";
import { makeAuthRoutes } from "./authRoutes";
import { makeGuard } from "./guard";
import { makeSettingsRoutes } from "./settingsRoutes";
import { makeTradingRoutes } from "./tradingRoutes";
import { getTradingServices, startedTradingServices } from "@/server/trading/services";

export const guard = makeGuard(
  getAuthDeps,
  () => ({ appOrigin: getEnv().APP_ORIGIN, ipHeader: getEnv().TRUSTED_IP_HEADER }),
  getLogger,
);

const auth = makeAuthRoutes(getAuthDeps);
/** Auth routes have no session yet, but still go through the origin check (login CSRF). */
export const authRoutes = {
  login: guard.open(({ req, ip }) => auth.login(req, ip)),
  totp: guard.open(({ req, ip }) => auth.totp(req, ip)),
  logout: guard.open(({ req }) => auth.logout(req)),
  reauth: guard.open(({ req, ip }) => auth.reauth(req, ip)),
  session: guard.open(({ req }) => auth.session(req)),
};

export const adminRoutes = makeAdminRoutes(
  guard,
  () => getEnv().TRADING_HALTED,
  async () => {
    const svc = await startedTradingServices();
    svc?.runner.abortAll({ keepUrgent: true });
  },
);

export const tradingRoutes = makeTradingRoutes(guard, getTradingServices);

export const settingsRoutes = makeSettingsRoutes(guard, () => capsFromEnv(getEnv()));
