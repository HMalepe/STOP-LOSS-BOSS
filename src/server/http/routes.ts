/** The route handlers wired to the real process services. Route files import from here. */
import { getAuthDeps, getDb } from "@/server/context";
import { capsFromEnv } from "@/server/caps";
import { getEnv } from "@/server/env";
import { getLogger } from "@/server/logger";
import { makeAdminRoutes } from "./adminRoutes";
import { makeAuthRoutes } from "./authRoutes";
import { makeGuard } from "./guard";
import { makePresetRoutes } from "./presetRoutes";
import { makeSettingsRoutes } from "./settingsRoutes";
import { makeTradingRoutes } from "./tradingRoutes";
import { getTradingServices, readyTradingServices, startedTradingServices } from "@/server/trading/services";
import { systemClock } from "@/server/clock";
import { makeHealthRoutes } from "./healthRoutes";

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
  () => readyTradingServices()?.observability.snapshot(),
);

export const healthRoutes = makeHealthRoutes({
  clock: systemClock,
  db: getDb,
  services: readyTradingServices,
  startServices: () => {
    getTradingServices().catch(() => undefined);
  },
});

export const tradingRoutes = makeTradingRoutes(guard, getTradingServices);

export const presetRoutes = makePresetRoutes(guard, getTradingServices);

export const settingsRoutes = makeSettingsRoutes(guard, () => capsFromEnv(getEnv()));
