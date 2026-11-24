/** TradingServices on a MockBroker (no real latency) with the real runner and the DB-backed execution store. */
import { Observability } from "@/server/observability";
import { TaskTracker } from "@/server/shutdown";
import type { ManualClock } from "@/domain/clock";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import type { Db } from "@/server/db/sql";
import { buildRunner, demoMockBroker, type TradingServices } from "@/server/trading/services";
import { SpecCache } from "@/server/trading/specCache";

export function mockServices(
  db: Db,
  clock: ManualClock,
  over: Partial<TradingServices> = {},
): { svc: TradingServices; broker: MockBroker } {
  const broker = demoMockBroker(clock, { sleep: () => Promise.resolve() });
  const b = over.broker ?? broker;
  const svc: TradingServices = {
    broker: b,
    specs: new SpecCache((x) => b.getSymbolSpec(x), clock),
    mode: "mock",
    envHalted: false,
    clock,
    runner: buildRunner(b, db, clock),
    background: new TaskTracker(),
    observability: new Observability({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
    accountRef: null,
    magicPrefix: 7731,
    capCeilings: { maxOrdersPerAction: 100, maxTotalLots: 5, maxRiskPct: 2, maxPositionsPerBatch: 1_000 },
    ...over,
  };
  return { svc, broker };
}

/** The mock, but reporting itself as a MetaApi connection to an account of the given type (for live/demo gate tests). */
export function asAccount(b: MockBroker, tradeMode: "DEMO" | "CONTEST" | "REAL"): BrokerProvider {
  return new Proxy(b, {
    get(target, prop, recv) {
      if (prop === "name") return "metaapi";
      if (prop === "getAccount") return async () => ({ ...(await target.getAccount()), tradeMode });
      const v: unknown = Reflect.get(target, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
