/**
 * docs/04 contract (Phase 06 M5): every error code is produced by a real request and has the documented status and
 * shape; success bodies match the contract schemas; docs/openapi.json is what the generator produces; every documented
 * operation has a route file exporting that method.
 */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockBroker } from "@/broker/MockBroker";
import { PENDING_COOKIE } from "@/server/auth/cookies";
import { LIMITS, passwordStep } from "@/server/auth/login";
import { makeAdminRoutes } from "@/server/http/adminRoutes";
import { makeAuthRoutes } from "@/server/http/authRoutes";
import {
  buildOpenApi,
  closeNowAccepted,
  errorBody,
  executeAccepted,
  executionStatus,
  historyPage,
  OPERATIONS,
  planSummary,
  planViolation,
  positionsPage,
  sseItem,
  stateView,
} from "@/server/http/contract";
import { ERROR_CODES, statusOf, type ErrorCode } from "@/server/http/respond";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { setKillSwitch } from "@/server/killSwitch";
import { PLAN_TTL_MS } from "@/server/trading/plans";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { get, ORIGIN, post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let broker: MockBroker;
let svc: TradingServices;
let routes: ReturnType<typeof makeTradingRoutes>;

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
  routes = makeTradingRoutes(s.guard, () => Promise.resolve(svc));
});
afterEach(async () => {
  await s.db.close();
});

const BUYS = { symbol: "XAUUSD", side: "BUY" };
async function planId(body: Record<string, unknown> = { action: "levels", filter: BUYS, stopLoss: 2600 }) {
  const res = await routes.createPlan(post("/api/plans", body, s.cookie));
  return planSummary.parse(await res.json()).id;
}
const exec = (id: string, r = routes) => r.execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
async function drain(executionId: string) {
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
}

const covered = new Set<ErrorCode>();
async function expectError(res: Response, code: ErrorCode): Promise<unknown> {
  const body = errorBody.parse(await res.json());
  expect([res.status, body.error.code]).toEqual([statusOf(code), code]);
  expect(res.headers.get("cache-control")).toBe("no-store");
  covered.add(code);
  return body.error.details;
}

describe("every error code in docs/04, from a real request", () => {
  it("UNAUTHENTICATED", async () => {
    await expectError(await routes.state(get("/api/state")), "UNAUTHENTICATED");
  });

  it("TOTP_REQUIRED: password done, code not yet", async () => {
    const p = await passwordStep(s.deps, { password: "a very good password", ip: "198.51.100.40" });
    if (!p.ok) throw new Error("setup");
    await expectError(
      await routes.state(get("/api/state", `${PENDING_COOKIE}=${p.pendingToken}`)),
      "TOTP_REQUIRED",
    );
  });

  it("REAUTH_REQUIRED", async () => {
    s.clock.advance(LIMITS.reauthWindowMs + 1);
    const admin = makeAdminRoutes(s.guard, () => false);
    await expectError(
      await admin.killSwitchSet(post("/api/admin/kill-switch", { halted: false }, s.cookie)),
      "REAUTH_REQUIRED",
    );
  });

  it("RATE_LIMITED (with Retry-After)", async () => {
    const auth = makeAuthRoutes(() => Promise.resolve(s.deps));
    const wrong = () =>
      auth.login(post("/api/auth/login", { password: "wrong wrong wrong" }), "203.0.113.200");
    for (let i = 0; i < LIMITS.failuresPerMinute; i++) await wrong();
    const res = await wrong();
    expect(res.headers.get("retry-after")).toBe("60");
    await expectError(res, "RATE_LIMITED");
  });

  it("VALIDATION", async () => {
    await expectError(
      await routes.createPlan(post("/api/plans", { action: "levels" }, s.cookie)),
      "VALIDATION",
    );
  });

  it("FORBIDDEN_ORIGIN", async () => {
    const res = await routes.closeNow(
      new Request(`${ORIGIN}/api/close-now`, {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: s.cookie },
        body: "{}",
      }),
    );
    await expectError(res, "FORBIDDEN_ORIGIN");
  });

  it("PLAN_INVALID with [{side, rule, boundary, message}]", async () => {
    const res = await routes.createPlan(
      post("/api/plans", { action: "levels", filter: { ...BUYS, side: "SELL" }, stopLoss: 2600 }, s.cookie),
    );
    const details = (await expectError(res, "PLAN_INVALID")) as unknown[];
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) planViolation.parse(d);
  });

  it("PLAN_EXPIRED", async () => {
    const id = await planId();
    s.clock.advance(PLAN_TTL_MS);
    await expectError(await exec(id), "PLAN_EXPIRED");
  });

  it("PLAN_ALREADY_EXECUTED (details carry the execution id)", async () => {
    const id = await planId();
    const first = executeAccepted.parse(await (await exec(id)).json());
    await drain(first.executionId);
    expect(await expectError(await exec(id), "PLAN_ALREADY_EXECUTED")).toEqual({
      executionId: first.executionId,
    });
  });

  it("PRICE_MOVED", async () => {
    const id = await planId({ action: "levels", filter: BUYS, stopLoss: 2640 });
    broker.setQuote("XAUUSD", 2639.5, 2639.7);
    await expectError(await exec(id), "PRICE_MOVED");
  });

  it("PRICE_STALE", async () => {
    const id = await planId();
    const b = broker;
    const stale = makeTradingRoutes(s.guard, () =>
      Promise.resolve({
        ...svc,
        broker: new Proxy(b, {
          get(t, prop, recv) {
            if (prop === "getQuote") return async (x: string) => ({ ...(await t.getQuote(x)), time: 0 });
            const v: unknown = Reflect.get(t, prop, recv);
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        }),
      }),
    );
    await expectError(await exec(id, stale), "PRICE_STALE");
  });

  it("TRADING_HALTED", async () => {
    const id = await planId();
    await setKillSwitch(s.deps, true, s.owner);
    await expectError(await exec(id), "TRADING_HALTED");
  });

  it("LIVE_NOT_ENABLED and ACCOUNT_MODE_MISMATCH", async () => {
    const live = makeTradingRoutes(s.guard, () =>
      Promise.resolve({ ...svc, mode: "live", accountRef: "acc-9" }),
    );
    const id = await planId();
    await expectError(await exec(id, live), "LIVE_NOT_ENABLED");
    await s.db.query("insert into accounts (metaapi_account_id, live_enabled) values ('acc-9', true)");
    await expectError(await exec(id, live), "ACCOUNT_MODE_MISMATCH");
  });

  it("BROKER_UNAVAILABLE", async () => {
    broker.setConnected(false);
    await expectError(await routes.state(get("/api/state", s.cookie)), "BROKER_UNAVAILABLE");
  });

  it("NOT_FOUND", async () => {
    await expectError(await routes.getPlan(get("/api/plans/x", s.cookie), "x"), "NOT_FOUND");
  });

  it("INTERNAL: generic message, no details leaked", async () => {
    const broken = makeTradingRoutes(s.guard, () => Promise.reject(new Error("secret stack detail")));
    const res = await broken.state(get("/api/state", s.cookie));
    const text = await res.clone().text();
    expect(text).not.toContain("secret");
    await expectError(res, "INTERNAL");
  });

  afterAll(() => {
    expect([...covered].sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe("success bodies match the contract", () => {
  it("state, positions, plan, execute, status, SSE items, close-now, history", async () => {
    stateView.parse(await (await routes.state(get("/api/state?symbol=XAUUSD", s.cookie))).json());
    positionsPage.parse(await (await routes.positions(get("/api/positions?symbol=XAUUSD", s.cookie))).json());
    const id = await planId({ action: "levels", filter: BUYS, takeProfit: 2700 });
    const { executionId } = executeAccepted.parse(await (await exec(id)).json());
    await drain(executionId);
    executionStatus.parse(
      await (await routes.execution(get(`/api/executions/${executionId}`, s.cookie), executionId)).json(),
    );
    const sse = await (
      await routes.stream(get(`/api/executions/${executionId}/stream`, s.cookie), executionId)
    ).text();
    const items = [...sse.matchAll(/^event: item\ndata: (.*)$/gm)].map((m) =>
      sseItem.parse(JSON.parse(m[1] ?? "")),
    );
    expect(items).toHaveLength(3);
    const close = closeNowAccepted.parse(
      await (
        await routes.closeNow(
          post("/api/close-now", { filter: { symbol: "XAUUSD", side: "ALL" }, confirm: "CLOSE" }, s.cookie),
        )
      ).json(),
    );
    await drain(close.executionId);
    historyPage.parse(await (await routes.history(get("/api/history", s.cookie))).json());
  });
});

describe("docs/openapi.json", () => {
  it("is exactly what the generator produces (run `pnpm openapi` after changing a schema)", () => {
    expect(JSON.parse(readFileSync("docs/openapi.json", "utf8"))).toEqual(
      JSON.parse(JSON.stringify(buildOpenApi())),
    );
  });

  it("every documented operation has a route file exporting that method", () => {
    for (const op of OPERATIONS) {
      const file = `src/app${op.path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`;
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8"), `${op.method.toUpperCase()} ${op.path}`).toMatch(
        new RegExp(`export (async )?function ${op.method.toUpperCase()}\\(`),
      );
    }
  });
});
