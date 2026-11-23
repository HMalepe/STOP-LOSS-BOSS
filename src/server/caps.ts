/**
 * Trading caps (docs/05, OD7): stored in `config` under "caps", changed only with a fresh re-auth, audited.
 *
 * The env values (MAX_*) are hard ceilings set at deploy time. The owner can lower a cap from the phone and raise it
 * back up to its ceiling, never past it: a stolen session plus a TOTP code still can't exceed what the server was
 * deployed with. A ceiling lowered by a redeploy wins over a higher stored value.
 */
import { z } from "zod";
import { audit, auditKey } from "./audit/audit";
import type { AuthDeps } from "./auth/login";
import type { Db } from "./db/sql";
import type { Env } from "./env";

export interface Caps {
  readonly maxOrdersPerAction: number;
  readonly maxTotalLots: number;
  readonly maxRiskPct: number;
  readonly maxPositionsPerBatch: number;
}
type CapKey = keyof Caps;

const ENV_NAME: Record<CapKey, string> = {
  maxOrdersPerAction: "MAX_ORDERS_PER_ACTION",
  maxTotalLots: "MAX_TOTAL_LOTS",
  maxRiskPct: "MAX_RISK_PCT_PER_ACTION",
  maxPositionsPerBatch: "MAX_POSITIONS_PER_BATCH",
};
const KEYS = Object.keys(ENV_NAME) as CapKey[];
const CONFIG_KEY = "caps";

export function capsFromEnv(
  env: Pick<
    Env,
    "MAX_ORDERS_PER_ACTION" | "MAX_TOTAL_LOTS" | "MAX_RISK_PCT_PER_ACTION" | "MAX_POSITIONS_PER_BATCH"
  >,
): Caps {
  return {
    maxOrdersPerAction: env.MAX_ORDERS_PER_ACTION,
    maxTotalLots: env.MAX_TOTAL_LOTS,
    maxRiskPct: env.MAX_RISK_PCT_PER_ACTION,
    maxPositionsPerBatch: env.MAX_POSITIONS_PER_BATCH,
  };
}

/** Exactly n decimal places or fewer, without float tricks (0.07 * 100 is 7.000000000000001). */
const decimals = (n: number) => (v: number) => {
  const scaled = v * 10 ** n;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
};

/**
 * The request body. Bounds here are the env schema's sanity limits; the deploy's own ceilings are checked separately
 * (`overCeiling`) so the message can name the env var.
 */
export const capsPatchBody = z
  .strictObject({
    maxOrdersPerAction: z.number().int().min(1).max(500).optional(),
    maxTotalLots: z.number().min(0.01).max(100).refine(decimals(2), "lots go in steps of 0.01").optional(),
    maxRiskPct: z.number().min(0.01).max(10).refine(decimals(2), "at most 2 decimals").optional(),
    maxPositionsPerBatch: z.number().int().min(1).max(5000).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "change at least one cap");
export type CapsPatch = z.infer<typeof capsPatchBody>;

export function overCeiling(patch: CapsPatch, ceilings: Caps): string | null {
  for (const k of KEYS) {
    const v = patch[k];
    if (v !== undefined && v > ceilings[k]) {
      return `${k} can be at most ${String(ceilings[k])} (the server's ${ENV_NAME[k]}). Nothing was changed.`;
    }
  }
  return null;
}

/** Stored values that are still sane; anything else falls back to the ceiling. */
function stored(value: unknown): Partial<Caps> {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const out: Partial<Record<CapKey, number>> = {};
  for (const k of KEYS) {
    const x = v[k];
    if (typeof x === "number" && Number.isFinite(x) && x > 0) out[k] = x;
  }
  return out;
}

function resolve(saved: Partial<Caps>, ceilings: Caps): Caps {
  const pick = (k: CapKey) => Math.min(saved[k] ?? ceilings[k], ceilings[k]);
  return {
    maxOrdersPerAction: pick("maxOrdersPerAction"),
    maxTotalLots: pick("maxTotalLots"),
    maxRiskPct: pick("maxRiskPct"),
    maxPositionsPerBatch: pick("maxPositionsPerBatch"),
  };
}

async function readStored(db: Db, lock = false): Promise<Partial<Caps>> {
  const [row] = await db.query<{ value: unknown }>(
    `select value from config where key = $1${lock ? " for update" : ""}`,
    [CONFIG_KEY],
  );
  return stored(row?.value);
}

export async function effectiveCaps(db: Db, ceilings: Caps): Promise<Caps> {
  return resolve(await readStored(db), ceilings);
}

/** The change and its audit row (before/after) commit together. The route has already checked re-auth and ceilings. */
export async function setCaps(
  deps: Pick<AuthDeps, "db" | "clock" | "sessionSecret">,
  ceilings: Caps,
  patch: CapsPatch,
  actor: { readonly userId: string },
): Promise<Caps> {
  const at = new Date(deps.clock.now());
  return deps.db.tx(async (t) => {
    const saved = await readStored(t, true);
    const before = resolve(saved, ceilings);
    // Key by key: an explicit `undefined` in the patch must never wipe a stored cap.
    const next: Partial<Record<CapKey, number>> = { ...saved };
    for (const k of KEYS) {
      const v = patch[k];
      if (v !== undefined) next[k] = v;
    }
    await t.query(
      "insert into config (key, value, updated_at, updated_by) values ($1, $2::jsonb, $3, $4) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      [CONFIG_KEY, JSON.stringify(next), at.toISOString(), actor.userId],
    );
    const after = resolve(next, ceilings);
    await audit(
      t,
      auditKey(deps.sessionSecret),
      { actor: "owner", action: "caps.changed", subject: actor.userId, details: { before, after } },
      at,
    );
    return after;
  });
}
