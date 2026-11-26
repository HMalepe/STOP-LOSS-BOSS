/**
 * What trading routes need: the broker for this mode, the spec cache, the mode and the env kill switch.
 *
 * The broker factory FAILS CLOSED (carry-over from the Phase 03 review): before the first use, the account type the
 * broker reports must match TRADING_MODE. A "demo" app connected to a REAL account never gets a broker at all.
 * Mock mode gets an in-process MockBroker with a small demo book, so `pnpm dev` is fully usable offline.
 */
import type { AccountTradeMode, BrokerProvider } from "@/broker/BrokerProvider";
import { MockBroker } from "@/broker/MockBroker";
import { sharedMetaApiBroker } from "@/broker/metaapi";
import { openMetaApiConnection } from "@/broker/metaapi/sdk";
import type { Clock } from "@/domain/clock";
import { systemClock } from "../clock";
import { getEnv, type Env, type TradingMode } from "../env";
import { CreditLimiter } from "@/execution/rateLimiter";
import { InProcessRunner, type JobRunner } from "@/execution/jobRunner";
import { makeRevalidator } from "@/execution/revalidate";
import { realScheduler, type Scheduler } from "@/execution/scheduler";
import { getDb } from "../context";
import type { Db } from "../db/sql";
import { DbExecutionStore, recoverInterrupted } from "./executions";
import { SpecCache } from "./specCache";
import { SpreadSampler } from "./spread";
import type { EntryCaps } from "@/domain/entries";
import { DEFAULT_SPREAD, type SpreadConfig } from "@/domain/spreadGuard";

/** Order Desk settings (docs/03 §5, §9), read once from the env. */
export interface EntryConfig {
  readonly caps: EntryCaps;
  readonly commissionPerLot: number;
  /** R9.1: APP_MAGIC_PREFIX. */
  readonly magicPrefix: number;
  readonly spread: SpreadConfig;
  readonly sampler: SpreadSampler;
}

export interface TradingServices {
  readonly broker: BrokerProvider;
  readonly specs: SpecCache;
  readonly mode: TradingMode;
  readonly envHalted: boolean;
  readonly clock: Clock;
  readonly runner: JobRunner;
  readonly entry: EntryConfig;
  /** Most positions one preview may touch (MAX_POSITIONS_PER_BATCH). Close-now is exempt. */
  readonly maxPerBatch: number;
  /** The MetaApi account id (the accounts row whose live_enabled counts). null in mock mode. */
  readonly accountRef: string | null;
}

/** MetaApi's budget (09-PERFORMANCE): 5,000 credits / 10 s, 10 per trade. */
export const METAAPI_CREDITS = { capacity: 5_000, windowMs: 10_000, costPerTrade: 10 } as const;

/** One runner per process: the DB enforces one execution per plan, the limiter keeps us inside MetaApi's budget. */
export function buildRunner(
  broker: BrokerProvider,
  db: Db,
  clock: Clock,
  scheduler: Scheduler = realScheduler,
): JobRunner {
  return new InProcessRunner({
    broker,
    store: new DbExecutionStore(db, clock),
    scheduler,
    limiter: new CreditLimiter({
      capacity: METAAPI_CREDITS.capacity,
      windowMs: METAAPI_CREDITS.windowMs,
      maxInFlight: 16,
      scheduler,
    }),
    concurrency: 8,
    costPerTrade: METAAPI_CREDITS.costPerTrade,
    revalidate: makeRevalidator(broker, { clock }),
  });
}

export class AccountModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountModeError";
  }
}

const ALLOWED: Record<Exclude<TradingMode, "mock">, ReadonlySet<AccountTradeMode>> = {
  demo: new Set(["DEMO", "CONTEST"]),
  live: new Set(["REAL"]),
};

/** Throws AccountModeError unless the broker's account type is allowed for this mode. */
export async function assertAccountMatchesMode(broker: BrokerProvider, mode: TradingMode): Promise<void> {
  if (mode === "mock") {
    if (broker.name !== "mock") throw new AccountModeError("Mock mode must use the mock broker.");
    return;
  }
  const { tradeMode } = await broker.getAccount();
  if (!ALLOWED[mode].has(tradeMode)) {
    throw new AccountModeError(
      `The app is in ${mode.toUpperCase()} mode but the broker account is ${tradeMode}. Refusing to trade.`,
    );
  }
}

/** A small, plausible book for mock mode: gold and EURUSD, a few positions each side, one pending order. */
export function demoMockBroker(
  clock: Clock,
  opts: { readonly sleep?: (ms: number) => Promise<void> } = {},
): MockBroker {
  const broker = new MockBroker({
    clock,
    seed: 7,
    latency: { p50: 120, p99: 900 },
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 250)))),
    symbols: [
      {
        spec: {
          symbol: "XAUUSD",
          digits: 2,
          point: 0.01,
          tickSize: 0.01,
          stopsLevel: 0,
          freezeLevel: 0,
          volumeMin: 0.01,
          volumeMax: 200,
          volumeStep: 0.01,
        },
        bid: 2650.1,
        ask: 2650.3,
        tickValue: 1,
        contractSize: 100,
      },
      {
        spec: {
          symbol: "EURUSD",
          digits: 5,
          point: 0.00001,
          tickSize: 0.00001,
          stopsLevel: 0,
          freezeLevel: 0,
          volumeMin: 0.01,
          volumeMax: 200,
          volumeStep: 0.01,
        },
        bid: 1.08601,
        ask: 1.08611,
        tickValue: 1,
        contractSize: 100_000,
      },
    ],
    account: { balance: 10_000, currency: "USD", leverage: 500, marginMode: "HEDGING", tradeMode: "DEMO" },
  });
  const gold = [2641.5, 2645.2, 2648.9, 2652.4, 2655.0];
  gold.forEach((openPrice, i) => {
    broker.seedPosition({
      symbol: "XAUUSD",
      side: i % 2 === 0 ? "BUY" : "SELL",
      volume: 0.1,
      openPrice,
      sl: null,
      tp: null,
      magic: 0,
    });
  });
  broker.seedPosition({
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.5,
    openPrice: 1.0841,
    sl: 1.079,
    tp: null,
    magic: 0,
  });
  broker.seedOrder({
    symbol: "XAUUSD",
    type: "BUY_LIMIT",
    volume: 0.1,
    openPrice: 2630,
    sl: 2620,
    tp: null,
    magic: 0,
  });
  return broker;
}

interface Shared {
  services?: Promise<TradingServices> | undefined;
}
const KEY = "__orderDeskTrading";
const g = globalThis as typeof globalThis & { [KEY]?: Shared };
const shared: Shared = (g[KEY] ??= {});

export function entryConfig(env: Env): EntryConfig {
  return {
    caps: {
      maxOrders: env.MAX_ORDERS_PER_ACTION,
      maxTotalLots: env.MAX_TOTAL_LOTS,
      maxRiskPct: env.MAX_RISK_PCT_PER_ACTION,
    },
    commissionPerLot: env.COMMISSION_PER_LOT,
    magicPrefix: env.APP_MAGIC_PREFIX,
    spread: {
      ...DEFAULT_SPREAD,
      k: env.SPREAD_GUARD_K,
      minSlackPoints: env.SPREAD_MIN_SLACK_POINTS,
      floorPoints: env.SPREAD_FLOOR_POINTS,
      absoluteMaxPoints: env.SPREAD_MAX_POINTS ?? null,
    },
    sampler: new SpreadSampler(env.SPREAD_WINDOW_SEC),
  };
}

async function create(env: Env, clock: Clock): Promise<TradingServices> {
  const broker: BrokerProvider =
    env.TRADING_MODE === "mock"
      ? demoMockBroker(clock)
      : await sharedMetaApiBroker(() =>
          openMetaApiConnection({
            token: env.METAAPI_TOKEN ?? "",
            accountId: env.METAAPI_ACCOUNT_ID ?? "",
            region: env.METAAPI_REGION ?? "",
          }),
        );
  await assertAccountMatchesMode(broker, env.TRADING_MODE);
  const db = await getDb();
  const runner = buildRunner(broker, db, clock);
  // A fresh process holds no runs: anything still "running" in the database was cut off by a restart.
  await recoverInterrupted(db, (id) => runner.status(id)?.state === "running");
  return {
    broker,
    specs: new SpecCache((s) => broker.getSymbolSpec(s), clock),
    mode: env.TRADING_MODE,
    envHalted: env.TRADING_HALTED,
    clock,
    runner,
    maxPerBatch: env.MAX_POSITIONS_PER_BATCH,
    entry: entryConfig(env),
    accountRef: env.TRADING_MODE === "mock" ? null : (env.METAAPI_ACCOUNT_ID ?? null),
  };
}

/** Process-wide services. A failed start (broker down, wrong account) is forgotten so the next request retries. */
export function getTradingServices(): Promise<TradingServices> {
  shared.services ??= create(getEnv(), systemClock).catch((e: unknown) => {
    shared.services = undefined;
    throw e;
  });
  return shared.services;
}

/** The services if they've already started; never connects a broker just to ask. */
export function startedTradingServices(): Promise<TradingServices> | undefined {
  return shared.services;
}
