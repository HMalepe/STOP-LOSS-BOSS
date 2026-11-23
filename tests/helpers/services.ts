/** TradingServices on a MockBroker (no real latency) with the real runner and the DB-backed execution store. */
import type { ManualClock } from "@/domain/clock";
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
    accountRef: null,
    ...over,
  };
  return { svc, broker };
}
