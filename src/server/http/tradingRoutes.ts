/** GET /api/state, GET /api/positions (docs/04). Later milestones add plans, execute, close-now, history. */
import { z } from "zod";
import { BrokerError } from "@/broker/BrokerProvider";
import { killSwitchState } from "@/server/killSwitch";
import { AccountModeError, type TradingServices } from "@/server/trading/services";
import { loadState, pagePositions } from "@/server/trading/state";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");

const stateQuery = z.object({ symbol: SYMBOL.optional() });
const positionsQuery = z.object({
  symbol: SYMBOL.optional(),
  side: z.enum(["ALL", "BUY", "SELL"]).default("ALL"),
  cursor: z.string().max(64).optional(),
});

function query<T>(
  req: Request,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; message: string } {
  const params = Object.fromEntries([...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""));
  const r = schema.safeParse(params);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    message: first === undefined ? "Invalid query." : `${first.path.join(".") || "query"}: ${first.message}`,
  };
}

/** Broker trouble is a 503 with a plain message, never stale data; a wrong account type is refused outright. */
export async function withBroker(
  services: () => Promise<TradingServices>,
  run: (svc: TradingServices) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(await services());
  } catch (e) {
    if (e instanceof AccountModeError) return fail("ACCOUNT_MODE_MISMATCH", e.message);
    if (e instanceof BrokerError) {
      return fail("BROKER_UNAVAILABLE", "The broker isn't answering right now. Nothing was sent.", {
        details: { kind: e.kind },
      });
    }
    throw e;
  }
}

export function makeTradingRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
) {
  return {
    state: guard.authed({}, async ({ req, deps }) => {
      const q = query(req, stateQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      return withBroker(services, async (svc) =>
        ok(await loadState(svc, await killSwitchState(deps.db, svc.envHalted), q.value.symbol)),
      );
    }),

    positions: guard.authed({}, async ({ req }) => {
      const q = query(req, positionsQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      const { symbol, side, cursor } = q.value;
      return withBroker(services, async (svc) =>
        ok(
          pagePositions(
            await svc.broker.getPositions(),
            symbol === undefined ? { side } : { symbol, side },
            cursor,
          ),
        ),
      );
    }),
  };
}
