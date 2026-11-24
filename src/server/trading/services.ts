/**
 * What trading routes need: the broker for this mode, the spec cache, the mode and the env kill switch.
 *
 * The broker factory FAILS CLOSED (carry-over from the Phase 03 review): before the first use, the account type the
 * broker reports must match TRADING_MODE. A "demo" app connected to a REAL account never gets a broker at all.
 * Mock mode gets an in-process MockBroker with a small demo book, so `pnpm dev` is fully usable offline.
 */
import type { AccountTradeMode, BrokerProvider } from "@/broker/BrokerProvider";
import { MockBroker } from "@/broker/MockBroker";
import { closeSharedMetaApiBroker, sharedMetaApiBroker } from "@/broker/metaapi";
import { openMetaApiConnection } from "@/broker/metaapi/sdk";
import type { Clock } from "@/domain/clock";
import { systemClock } from "../clock";
import { capsFromEnv, type Caps } from "../caps";
import { getLogger } from "../logger";
import { Observability } from "../observability";
import { getEnv, type Env, type TradingMode } from "../env";
import { CircuitBreaker } from "@/execution/circuitBreaker";
import { CreditLimiter } from "@/execution/rateLimiter";
import { InProcessRunner, type JobRunner } from "@/execution/jobRunner";
import { makeRevalidator } from "@/execution/revalidate";
import { realScheduler, type Scheduler } from "@/execution/scheduler";
import { getDb, startedDb } from "../context";
import type { Db } from "../db/sql";
import { DbExecutionStore, markInterrupted, recoverInterrupted } from "./executions";
import { shutdown, TaskTracker, type ShutdownOptions, type ShutdownReport } from "../shutdown";
import { SpecCache } from "./specCache";
import { SpreadMonitor } from "./spreadMonitor";

export interface TradingServices {
  readonly broker: BrokerProvider;
  readonly specs: SpecCache;
  readonly mode: TradingMode;
  readonly envHalted: boolean;
  readonly clock: Clock;
  readonly runner: JobRunner;
  /** Result writes still in progress; graceful shutdown waits for them before closing the database. */
  readonly background: TaskTracker;
  /** Structured call logs, counters and alerts (observability.ts). */
  readonly observability: Observability;
  /** Hard ceilings from the env (MAX_*). The owner's own caps (Settings) can only be at or below these. */
  readonly capCeilings: Caps;
  /** R9.4 spread guard: recent spreads per symbol, K and the optional absolute max per symbol. */
  readonly spread: SpreadMonitor;
  readonly spreadGuard: { readonly k: number; readonly maxPts: Readonly<Record<string, number>> };
  /** R9.1 APP_MAGIC_PREFIX: every Order Desk batch's magic is prefix × 10^9 + seq. */
  readonly magicPrefix: number;
  /** The MetaApi account id (the accounts row whose live_enabled counts). null in mock mode. */
  readonly accountRef: string | null;
}

/** MetaApi's budget (09-PERFORMANCE): 5,000 credits / 10 s, 10 per trade. */
export const METAAPI_CREDITS = { capacity: 5_000, windowMs: 10_000, costPerTrade: 10 } as const;

/** 5 connection failures in a row open it; a health probe after 5 s decides when to try again (circuitBreaker.ts). */
export const BREAKER = { threshold: 5, cooldownMs: 5_000 } as const;

/** One runner per process: the DB enforces one execution per plan, the limiter keeps us inside MetaApi's budget. */
export function buildRunner(
  broker: BrokerProvider,
  db: Db,
  clock: Clock,
  scheduler: Scheduler = realScheduler,
  obs?: Observability,
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
    breaker: new CircuitBreaker({
      threshold: BREAKER.threshold,
      cooldownMs: BREAKER.cooldownMs,
      clock,
      ...(obs === undefined
        ? {}
        : {
            onChange: (state, reason) => {
              obs.breaker(state, reason);
            },
          }),
      probe: async () => {
        const h = await broker.health();
        return h.connected && h.connectedToBroker && h.synchronized;
      },
    }),
    revalidate: makeRevalidator(broker, { clock }),
    ...(obs === undefined
      ? {}
      : {
          onCall: (e) => {
            obs.call(e);
          },
          onEvent: (executionId, event, urgent) => {
            if (event.type === "item") obs.item(executionId, event.item);
            else obs.complete(executionId, event.summary, urgent);
          },
        }),
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
  /** The same services once the start has finished (sync access for health checks). */
  ready?: TradingServices | undefined;
}
const KEY = "__orderDeskTrading";
const g = globalThis as typeof globalThis & { [KEY]?: Shared };
const shared: Shared = (g[KEY] ??= {});

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
  const observability = new Observability(getLogger());
  const runner = buildRunner(broker, db, clock, realScheduler, observability);
  // A fresh process holds no runs: anything still "running" in the database was cut off by a restart.
  observability.interrupted(
    await recoverInterrupted(db, (id) => runner.status(id)?.state === "running"),
    "boot recovery",
  );
  return {
    broker,
    specs: new SpecCache((s) => broker.getSymbolSpec(s), clock),
    mode: env.TRADING_MODE,
    envHalted: env.TRADING_HALTED,
    clock,
    runner,
    background: new TaskTracker(),
    observability,
    capCeilings: capsFromEnv(env),
    magicPrefix: env.APP_MAGIC_PREFIX,
    spread: new SpreadMonitor({
      windowMs: env.SPREAD_WINDOW_SEC * 1_000,
      clock,
      every: (ms, fn) => {
        const t = setInterval(fn, ms);
        t.unref();
        return () => {
          clearInterval(t);
        };
      },
    }),
    spreadGuard: { k: env.SPREAD_GUARD_K, maxPts: env.SPREAD_MAX_POINTS },
    accountRef: env.TRADING_MODE === "mock" ? null : (env.METAAPI_ACCOUNT_ID ?? null),
  };
}

/** Process-wide services. A failed start (broker down, wrong account) is forgotten so the next request retries. */
export function getTradingServices(): Promise<TradingServices> {
  shared.services ??= create(getEnv(), systemClock).then(
    (svc) => {
      shared.ready = svc;
      return svc;
    },
    (e: unknown) => {
      shared.services = undefined;
      throw e;
    },
  );
  return shared.services;
}

/**
 * SIGTERM: drain and close what's open. Never starts services or opens a database just to shut them down.
 * The shared MetaApi connection is closed through closeSharedMetaApiBroker (it also stops the watchdog).
 */
export async function shutdownTradingServices(
  opts: Omit<ShutdownOptions, "sleep"> = {},
): Promise<ShutdownReport> {
  const svc = await shared.services?.catch(() => undefined);
  const db = await startedDb()?.catch(() => undefined);
  const sleep = (ms: number) => realScheduler.sleep(ms);
  if (svc === undefined || db === undefined) {
    await closeSharedMetaApiBroker();
    if (db !== undefined) await db.close().catch(() => undefined);
    return shutdown(undefined, { sleep });
  }
  const report = await shutdown(
    {
      runner: svc.runner,
      background: svc.background,
      broker: svc.broker.name === "metaapi" ? { close: closeSharedMetaApiBroker } : svc.broker,
      db,
      markInterrupted,
    },
    { ...opts, sleep },
  );
  svc.observability.interrupted(report.interrupted, "shutdown could not drain");
  return report;
}

/** Started and finished starting, or undefined. Never starts anything. */
export function readyTradingServices(): TradingServices | undefined {
  return shared.ready;
}

/** The services if they've already started; never connects a broker just to ask. */
export function startedTradingServices(): Promise<TradingServices> | undefined {
  return shared.services;
}
