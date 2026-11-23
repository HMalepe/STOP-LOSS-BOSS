/** Graceful shutdown through the real runner, routes and database. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import type { MockBroker } from "@/broker/MockBroker";
import type { Db } from "@/server/db/sql";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { markInterrupted } from "@/server/trading/executions";
import { buildRunner, type TradingServices } from "@/server/trading/services";
import { shutdown } from "@/server/shutdown";
import { mockServices } from "../helpers/services";
import { post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let svc: TradingServices;
let broker: MockBroker;

beforeEach(async () => {
  s = await signedIn();
  ({ svc, broker } = mockServices(s.db, s.clock));
});
afterEach(async () => {
  await s.db.close();
});

type Json = Record<string, unknown>;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The test owns the database's lifetime; shutdown's close is observed, not executed. */
const keepOpen = (db: Db): Db & { closed: boolean } => {
  const w = { ...db, closed: false, close: () => ((w.closed = true), Promise.resolve()) };
  return w;
};
const routesFor = (x: TradingServices) => makeTradingRoutes(s.guard, () => Promise.resolve(x));
async function preview(x: TradingServices): Promise<string> {
  const res = await routesFor(x).createPlan(
    post(
      "/api/plans",
      { action: "levels", filter: { symbol: "XAUUSD", side: "BUY" }, takeProfit: 2700 },
      s.cookie,
    ),
  );
  return String(((await res.json()) as Json).id);
}
const target = (x: TradingServices, db: Db, b: Pick<BrokerProvider, "close">) => ({
  runner: x.runner,
  background: x.background,
  broker: b,
  db,
  markInterrupted,
});

describe("graceful shutdown", () => {
  it("a run in progress finishes and its results are saved before the database closes; new executes get 503", async () => {
    const id = await preview(svc);
    const later = await preview(svc);
    const started = await routesFor(svc).execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    const { executionId } = (await started.json()) as { executionId: string };
    const db = keepOpen(s.db);

    // The broker stays up here so the request reaches the runner (a closed broker answers BROKER_UNAVAILABLE first).
    let brokerClosed = false;
    const report = await shutdown(
      target(svc, db, { close: () => ((brokerClosed = true), Promise.resolve()) }),
      { sleep: realSleep, drainMs: 5_000 },
    );
    expect(brokerClosed).toBe(true);
    expect(report).toMatchObject({ drained: true, interrupted: [], errors: [] });
    expect(db.closed).toBe(true);
    const [exec] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    expect(exec?.status).toBe("complete");
    const states = await s.db.query<{ state: string }>(
      "select state from execution_items where execution_id = $1",
      [executionId],
    );
    expect(states.every((r) => r.state === "done")).toBe(true);

    const refused = await routesFor(svc).execute(post(`/api/plans/${later}/execute`, {}, s.cookie), later);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Retry-After")).toBe("5");
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("SHUTTING_DOWN");
    // Nothing was claimed: the same plan is still executable (on the next instance).
    const [plan] = await s.db.query<{ status: string }>("select status from plans where id = $1", [later]);
    expect(plan?.status).toBe("created");
  });

  it("a broker that never answers: past the deadline the run is interrupted, every item honest (none left sending)", async () => {
    const hung: BrokerProvider = new Proxy(broker, {
      get(t, prop, recv) {
        if (prop === "modifyPosition") return () => new Promise(() => undefined);
        const v: unknown = Reflect.get(t, prop, recv);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const x: TradingServices = { ...svc, broker: hung, runner: buildRunner(hung, s.db, s.clock) };
    const id = await preview(x);
    const res = await routesFor(x).execute(post(`/api/plans/${id}/execute`, {}, s.cookie), id);
    const { executionId } = (await res.json()) as { executionId: string };
    await realSleep(50);

    const report = await shutdown(target(x, keepOpen(s.db), broker), {
      sleep: realSleep,
      drainMs: 100,
      graceMs: 50,
    });
    expect(report).toMatchObject({ drained: false, interrupted: [executionId] });
    const [exec] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    expect(exec?.status).toBe("interrupted");
    const states = await s.db.query<{ state: string }>(
      "select state from execution_items where execution_id = $1",
      [executionId],
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((r) => r.state === "pending" || r.state === "sending")).toEqual([]);
    expect(states.some((r) => r.state === "unknown")).toBe(true);
  });
});
