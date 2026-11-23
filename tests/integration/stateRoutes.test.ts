import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerError } from "@/broker/BrokerProvider";
import { MockBroker } from "@/broker/MockBroker";
import { ManualClock } from "@/domain/clock";
import type { Position, SymbolSpec } from "@/domain/types";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import { AccountModeError, assertAccountMatchesMode, type TradingServices } from "@/server/trading/services";
import { SpecCache } from "@/server/trading/specCache";
import { pagePositions, summarise } from "@/server/trading/state";
import { mockServices } from "../helpers/services";
import { get, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let broker: MockBroker;
let svc: TradingServices;

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
});
afterEach(async () => {
  await s.db.close();
});

const routes = (services: () => Promise<TradingServices> = () => Promise.resolve(svc)) =>
  makeTradingRoutes(s.guard, services);

describe("GET /api/state", () => {
  it("account, mode, per-symbol summary, counts, kill switch; quote + spec for the asked symbol", async () => {
    const res = await routes().state(get("/api/state?symbol=XAUUSD", s.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: "mock",
      killSwitch: { halted: false, byEnv: false, byDb: false },
      account: { currency: "USD", tradeMode: "DEMO", marginMode: "HEDGING" },
      positions: 6,
      orders: 1,
      symbols: [
        { symbol: "EURUSD", buy: { count: 1, lots: 0.5 }, sell: { count: 0, lots: 0, profit: 0 }, orders: 0 },
        { symbol: "XAUUSD", buy: { count: 3, lots: 0.3 }, sell: { count: 2, lots: 0.2 }, orders: 1 },
      ],
      focus: { symbol: "XAUUSD", quote: { bid: 2650.1, ask: 2650.3 }, spec: { digits: 2 } },
    });
  });

  it("without a symbol there is no focus; the kill switch reflects the DB and env", async () => {
    await setKillSwitch(s.deps, true, s.owner);
    const body = (await (await routes().state(get("/api/state", s.cookie))).json()) as Record<
      string,
      unknown
    >;
    expect(body.focus).toBeUndefined();
    expect(body.killSwitch).toEqual({ halted: true, byEnv: false, byDb: true });
  });

  it("reads run in parallel (one slow read doesn't serialise the rest)", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow =
      <T>(p: () => Promise<T>) =>
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return p();
      };
    const b = broker;
    const wrapped = {
      ...svc,
      broker: Object.assign(Object.create(b) as MockBroker, {
        getAccount: slow(() => b.getAccount()),
        getPositions: slow(() => b.getPositions()),
        getOrders: slow(() => b.getOrders()),
        getQuote: (x: string) => slow(() => b.getQuote(x))(),
      }),
    };
    await routes(() => Promise.resolve(wrapped)).state(get("/api/state?symbol=XAUUSD", s.cookie));
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  it("broker down → 503 BROKER_UNAVAILABLE, never stale data", async () => {
    broker.setConnected(false);
    const res = await routes().state(get("/api/state", s.cookie));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "BROKER_UNAVAILABLE" } });
  });

  it("services that fail to start: broker error → 503, wrong account → 403, anything else → 500", async () => {
    const failing = (e: Error) => routes(() => Promise.reject(e));
    expect((await failing(new BrokerError("TIMEOUT", "x")).state(get("/api/state", s.cookie))).status).toBe(
      503,
    );
    const mismatch = await failing(new AccountModeError("REAL under demo")).state(
      get("/api/state", s.cookie),
    );
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ error: { code: "ACCOUNT_MODE_MISMATCH" } });
    expect((await failing(new Error("bug")).state(get("/api/state", s.cookie))).status).toBe(500);
  });

  it("needs a session; bad symbol → 400; unknown symbol → 503 (the broker can't quote it)", async () => {
    expect((await routes().state(get("/api/state"))).status).toBe(401);
    expect((await routes().state(get("/api/state?symbol=XAU%20USD;drop", s.cookie))).status).toBe(400);
    expect((await routes().state(get("/api/state?symbol=NOPE", s.cookie))).status).toBe(503);
  });
});

describe("GET /api/positions", () => {
  it("filters by symbol and side, pages at 500 with a cursor", async () => {
    for (let i = 0; i < 1_100; i++) {
      broker.seedPosition({
        symbol: "EURUSD",
        side: "SELL",
        volume: 0.01,
        openPrice: 1.09,
        sl: null,
        tp: null,
        magic: 0,
      });
    }
    const page = async (q: string) =>
      (await (await routes().positions(get(`/api/positions?${q}`, s.cookie))).json()) as {
        items: Position[];
        total: number;
        nextCursor: string | null;
      };
    const p1 = await page("symbol=EURUSD&side=SELL");
    expect([p1.items.length, p1.total]).toEqual([500, 1_100]);
    const p2 = await page(`symbol=EURUSD&side=SELL&cursor=${p1.nextCursor ?? ""}`);
    const p3 = await page(`symbol=EURUSD&side=SELL&cursor=${p2.nextCursor ?? ""}`);
    expect([p2.items.length, p3.items.length, p3.nextCursor]).toEqual([500, 100, null]);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(1_100);
    expect((await page("side=BUY")).total).toBe(4);
    expect((await page("")).total).toBe(1_106);
  });

  it("bad query → 400", async () => {
    expect((await routes().positions(get("/api/positions?side=LONG", s.cookie))).status).toBe(400);
  });
});

describe("pieces", () => {
  it("summaries add in cents/micro-lots (no float dust)", () => {
    const p = (volume: number, profit: number): Position => ({
      id: String(volume),
      symbol: "X",
      side: "BUY",
      volume,
      openPrice: 1,
      sl: null,
      tp: null,
      profit,
      magic: 0,
    });
    expect(summarise([p(0.1, 0.1), p(0.2, 0.2)], [])[0]?.buy).toEqual({ count: 2, lots: 0.3, profit: 0.3 });
  });

  it("paging past the end is empty, not an error", () => {
    expect(pagePositions([], { side: "ALL" }, "999")).toEqual({ items: [], total: 0, nextCursor: null });
  });

  it("spec cache: one fetch for concurrent misses, TTL, failures not cached, invalidate", async () => {
    const clock = new ManualClock(0);
    const spec = { symbol: "X" } as SymbolSpec;
    const fetch = vi
      .fn<(s: string) => Promise<SymbolSpec>>()
      .mockRejectedValueOnce(new BrokerError("TIMEOUT", "t"));
    fetch.mockResolvedValue(spec);
    const c = new SpecCache(fetch, clock, 1_000);
    await expect(c.get("X")).rejects.toThrow("t");
    await Promise.all([c.get("X"), c.get("X"), c.get("X")]);
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.advance(999);
    await c.get("X");
    expect(fetch).toHaveBeenCalledTimes(2);
    clock.advance(1);
    await c.get("X");
    expect(fetch).toHaveBeenCalledTimes(3);
    c.invalidate("X");
    await c.get("X");
    c.invalidate();
    await c.get("X");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("the broker factory fails closed when the account type doesn't match the mode", async () => {
    const account = (tradeMode: "DEMO" | "CONTEST" | "REAL") =>
      new MockBroker({
        clock: s.clock,
        symbols: [],
        account: { balance: 1, currency: "USD", leverage: 1, marginMode: "HEDGING", tradeMode },
      });
    await expect(assertAccountMatchesMode(account("DEMO"), "demo")).resolves.toBeUndefined();
    await expect(assertAccountMatchesMode(account("CONTEST"), "demo")).resolves.toBeUndefined();
    await expect(assertAccountMatchesMode(account("REAL"), "demo")).rejects.toThrow(
      /DEMO mode but the broker account is REAL/,
    );
    await expect(assertAccountMatchesMode(account("DEMO"), "live")).rejects.toThrow(AccountModeError);
    await expect(assertAccountMatchesMode(account("REAL"), "live")).resolves.toBeUndefined();
    await expect(assertAccountMatchesMode(account("REAL"), "mock")).resolves.toBeUndefined();
    const fake = Object.assign(Object.create(account("DEMO")) as MockBroker, { name: "metaapi" as const });
    await expect(assertAccountMatchesMode(fake, "mock")).rejects.toThrow(/mock broker/);
  });
});

describe("process services", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__orderDeskTrading;
  });

  it("mock mode: the demo MockBroker, created once, specs cached", async () => {
    vi.stubEnv("SESSION_SECRET", "t".repeat(48));
    vi.stubEnv("TRADING_MODE", "mock");
    vi.stubEnv("TRADING_HALTED", "1");
    vi.stubEnv("DATABASE_URL", "pglite://memory");
    const { getTradingServices } = await import("@/server/trading/services");
    const a = await getTradingServices();
    expect(await getTradingServices()).toBe(a);
    expect([a.broker.name, a.mode, a.envHalted]).toEqual(["mock", "mock", true]);
    expect((await a.specs.get("XAUUSD")).digits).toBe(2);
    expect((await a.broker.getOrders()).length).toBe(1);
  });
});
