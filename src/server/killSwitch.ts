/**
 * Kill switch (docs/05, CLAUDE.md non-negotiable 3): env TRADING_HALTED=1 OR the DB flag. Blocks every mutating trading
 * action except close-all-now (R4.2). Turning it ON never needs re-auth (getting safe must be instant); turning it OFF
 * does (the route enforces that). Every change is audited.
 */
import { audit, auditKey } from "./audit/audit";
import type { AuthDeps } from "./auth/login";
import type { Db } from "./db/sql";

export type TradingAction =
  "levels" | "closeAt" | "breakeven" | "lock" | "market" | "ladder" | "cancel" | "close";

/** R4.2: the panic button works even when everything else is halted. */
export const ALLOWED_WHEN_HALTED: ReadonlySet<TradingAction> = new Set(["close"]);

export interface KillSwitchState {
  readonly halted: boolean;
  readonly byEnv: boolean;
  readonly byDb: boolean;
}

const KEY = "kill_switch";

export async function killSwitchState(db: Db, envHalted: boolean): Promise<KillSwitchState> {
  const [row] = await db.query<{ value: { halted?: unknown } }>("select value from config where key = $1", [
    KEY,
  ]);
  const byDb = row?.value.halted === true;
  return { halted: envHalted || byDb, byEnv: envHalted, byDb };
}

/** The flag and its audit row commit together: there is never a change without its record, or a record without its change. */
export async function setKillSwitch(
  deps: Pick<AuthDeps, "db" | "clock" | "sessionSecret">,
  halted: boolean,
  actor: { readonly userId: string },
): Promise<void> {
  const at = new Date(deps.clock.now());
  await deps.db.tx(async (t) => {
    await t.query(
      "insert into config (key, value, updated_at, updated_by) values ($1, $2::jsonb, $3, $4) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      [KEY, JSON.stringify({ halted }), at.toISOString(), actor.userId],
    );
    await audit(
      t,
      auditKey(deps.sessionSecret),
      { actor: "owner", action: halted ? "kill_switch.on" : "kill_switch.off", subject: actor.userId },
      at,
    );
  });
}

export type Gate =
  { readonly ok: true } | { readonly ok: false; readonly code: "TRADING_HALTED"; readonly message: string };

export function tradingGate(action: TradingAction, state: KillSwitchState): Gate {
  if (!state.halted || ALLOWED_WHEN_HALTED.has(action)) return { ok: true };
  const by =
    state.byEnv && state.byDb
      ? "the server config and the app"
      : state.byEnv
        ? "the server config (TRADING_HALTED)"
        : "the app";
  return {
    ok: false,
    code: "TRADING_HALTED",
    message: `Trading is halted by ${by}. Only Close All Now works.`,
  };
}
