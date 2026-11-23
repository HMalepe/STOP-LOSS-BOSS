import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "@/domain/clock";
import { makeHealthRoutes, type HealthDeps } from "@/server/http/healthRoutes";

function deps(over: Partial<HealthDeps> = {}) {
  const clock = new ManualClock(0);
  const d: HealthDeps = {
    clock,
    db: () => Promise.resolve({ query: () => Promise.resolve([{ ok: 1 }]) }),
    services: () => ({
      broker: {
        health: () => Promise.resolve({ connected: true, connectedToBroker: true, synchronized: true }),
      },
      runner: { isAccepting: () => true },
    }),
    startServices: vi.fn(() => undefined),
    ...over,
  };
  return { d, clock };
}
const body = async (r: Response) => (await r.json()) as { ready: boolean; checks: Record<string, boolean> };

describe("GET /api/health (liveness)", () => {
  it("always 200, no details, never cached", async () => {
    const r = makeHealthRoutes(deps().d).live();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("GET /api/health/ready (readiness)", () => {
  it("all good → 200 with booleans only", async () => {
    const r = await makeHealthRoutes(deps().d).ready();
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ ready: true, checks: { db: true, broker: true, accepting: true } });
  });

  it("database down, broker not synchronized, or shutting down → 503 naming the failed check", async () => {
    const cases: [Partial<HealthDeps>, string][] = [
      [{ db: () => Promise.reject(new Error("refused")) }, "db"],
      [
        {
          services: () => ({
            broker: {
              health: () =>
                Promise.resolve({ connected: true, connectedToBroker: true, synchronized: false }),
            },
            runner: { isAccepting: () => true },
          }),
        },
        "broker",
      ],
      [
        {
          services: () => ({
            broker: { health: () => Promise.reject(new Error("x")) },
            runner: { isAccepting: () => true },
          }),
        },
        "broker",
      ],
      [
        {
          services: () => ({
            broker: {
              health: () => Promise.resolve({ connected: true, connectedToBroker: true, synchronized: true }),
            },
            runner: { isAccepting: () => false },
          }),
        },
        "accepting",
      ],
    ];
    for (const [over, failed] of cases) {
      const r = await makeHealthRoutes(deps(over).d).ready();
      expect(r.status, failed).toBe(503);
      expect((await body(r)).checks[failed], failed).toBe(false);
    }
  });

  it("a hung database check can't hang the probe", async () => {
    const { d } = deps({ db: () => new Promise(() => undefined) });
    const r = await makeHealthRoutes({ ...d, timeoutMs: 10 }).ready();
    expect((await body(r)).checks.db).toBe(false);
  });

  it("services not started: not ready, and a start is kicked at most once per 5 s (a public URL must not hammer MetaApi)", async () => {
    const { d, clock } = deps({ services: () => undefined });
    const routes = makeHealthRoutes(d);
    for (let i = 0; i < 5; i++) expect((await routes.ready()).status).toBe(503);
    expect(d.startServices).toHaveBeenCalledTimes(1);
    clock.advance(5_000);
    await routes.ready();
    expect(d.startServices).toHaveBeenCalledTimes(2);
  });
});
