/**
 * Health for the host (Fly/Railway checks, uptime monitors). Public and unauthenticated, so:
 * - booleans only, no versions, ids or error text;
 * - reads only (stream state and `select 1`), never a trade or a credit;
 * - a cold process is not "ready": the probe kicks a start, at most once per 5 s, so a stranger hitting this URL
 *   can't turn it into a MetaApi connect loop.
 *
 * live  → the process answers (restart it if not).
 * ready → database answers, broker connected AND synchronized, not shutting down (send traffic only if so).
 */
import type { BrokerHealth } from "@/broker/BrokerProvider";
import type { Clock } from "@/domain/clock";

export interface HealthDeps {
  readonly clock: Clock;
  readonly db: () => Promise<{ query: (sql: string) => Promise<unknown> }>;
  /** Started services, or undefined. Must never start anything itself. */
  readonly services: () =>
    | {
        readonly broker: { health(): Promise<BrokerHealth> };
        readonly runner: { isAccepting(): boolean };
      }
    | undefined;
  /** Start services in the background (errors handled by the caller). */
  readonly startServices: () => void;
  readonly timeoutMs?: number;
}

const KICK_EVERY_MS = 5_000;
const NO_STORE = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: NO_STORE });

export function makeHealthRoutes(d: HealthDeps) {
  let lastKick = Number.NEGATIVE_INFINITY;
  const timeout = d.timeoutMs ?? 2_000;
  const check = async (fn: () => Promise<boolean>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn().catch(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => {
            r(false);
          }, timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    live: (): Response => json({ ok: true }, 200),

    ready: async (): Promise<Response> => {
      const svc = d.services();
      if (svc === undefined && d.clock.now() - lastKick >= KICK_EVERY_MS) {
        lastKick = d.clock.now();
        d.startServices();
      }
      const [db, broker] = await Promise.all([
        check(async () => (await (await d.db()).query("select 1"), true)),
        svc === undefined
          ? Promise.resolve(false)
          : check(async () => {
              const h = await svc.broker.health();
              return h.connected && h.connectedToBroker && h.synchronized;
            }),
      ]);
      const accepting = svc?.runner.isAccepting() ?? false;
      const ready = db && broker && accepting;
      return json({ ready, checks: { db, broker, accepting } }, ready ? 200 : 503);
    },
  };
}
