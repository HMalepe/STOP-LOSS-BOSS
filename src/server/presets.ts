/**
 * Presets (OD3/OD4, R9.6): saved recipes the owner fires in one tap. A recipe is exactly an entry request
 * (`entryBody`, the same schema as POST /api/plans), so a saved preset can never be more lenient than a manual batch.
 *
 * What is stored is the RECIPE, never a plan: nothing is priced until fire time, and firing runs the normal preview
 * path (previewPlan) against the live quote and spec. Every change is audited in the same transaction.
 */
import { z } from "zod";
import { audit, auditKey } from "./audit/audit";
import type { AuthDeps } from "./auth/login";
import type { Db } from "./db/sql";
import { entryBody, type EntryBody } from "./trading/plans";

export const MAX_PRESETS = 50;
/** Advisory lock key for preset creation (distinct from the login and audit locks). */
const PRESET_LOCK = 7_731_050;

const NAME = z.string().trim().min(1, "Give the preset a name.").max(40, "Names are at most 40 characters.");

export const presetInput = z.strictObject({ name: NAME, recipe: entryBody, pinned: z.boolean().optional() });
export const presetPatch = z
  .strictObject({ name: NAME.optional(), recipe: entryBody.optional(), pinned: z.boolean().optional() })
  .refine((p) => Object.keys(p).length > 0, "Change at least one thing.");
export const reorderBody = z.strictObject({ ids: z.array(z.uuid()).min(1).max(MAX_PRESETS) });

export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly recipe: unknown;
  readonly pinned: boolean;
  readonly sort: number;
  /** R9.6: prices are stored in the recipe (ladders always; market batches with a price SL/TP). Re-validated at fire. */
  readonly absolutePrices: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PresetResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: "NOT_FOUND" | "VALIDATION"; readonly message: string };

const bad = (message: string) => ({ ok: false as const, code: "VALIDATION" as const, message });
const notFound = { ok: false as const, code: "NOT_FOUND" as const, message: "No such preset." };

export function hasAbsolutePrices(r: EntryBody): boolean {
  return r.action === "ladder" || r.stopLoss?.kind === "price" || r.takeProfit?.kind === "price";
}

interface Row {
  id: string;
  name: string;
  recipe: unknown;
  pinned: boolean;
  sort: number;
  created_at: Date | string;
  updated_at: Date | string;
}
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

function toPreset(r: Row): Preset {
  const parsed = entryBody.safeParse(r.recipe);
  return {
    id: r.id,
    name: r.name,
    recipe: r.recipe,
    pinned: r.pinned,
    sort: r.sort,
    // An unreadable recipe is shown (so it can be fixed or deleted) but flagged by firing refusing it.
    absolutePrices: parsed.success ? hasAbsolutePrices(parsed.data) : false,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const COLUMNS = "id, name, recipe, pinned, sort, created_at, updated_at";

/** Pinned first, then the owner's own order, then oldest first. */
export async function listPresets(db: Db, userId: string): Promise<Preset[]> {
  const rows = await db.query<Row>(
    `select ${COLUMNS} from presets where user_id = $1 order by pinned desc, sort asc, created_at asc, id asc`,
    [userId],
  );
  return rows.map(toPreset);
}

export async function getPreset(db: Db, userId: string, id: string): Promise<Preset | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.query<Row>(`select ${COLUMNS} from presets where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);
  return row === undefined ? null : toPreset(row);
}

type Deps = Pick<AuthDeps, "db" | "clock" | "sessionSecret">;
const record = (deps: Deps, t: Db, action: string, subject: string, details?: Record<string, unknown>) =>
  audit(
    t,
    auditKey(deps.sessionSecret),
    { actor: "owner", action, subject, ...(details === undefined ? {} : { details }) },
    new Date(deps.clock.now()),
  );

const nameTaken = async (t: Db, userId: string, name: string, exceptId?: string) =>
  (
    await t.query(
      "select 1 from presets where user_id = $1 and lower(name) = lower($2) and ($3::uuid is null or id <> $3::uuid)",
      [userId, name, exceptId ?? null],
    )
  ).length > 0;

export async function createPreset(
  deps: Deps,
  userId: string,
  input: z.infer<typeof presetInput>,
): Promise<PresetResult<Preset>> {
  return deps.db.tx(async (t) => {
    // Serialise this owner's creates so two at once can't both pass the cap or take the same sort slot.
    await t.query("select pg_advisory_xact_lock($1)", [PRESET_LOCK]);
    const [count] = await t.query<{ n: number; next: number }>(
      "select count(*)::int as n, coalesce(max(sort), -1) + 1 as next from presets where user_id = $1",
      [userId],
    );
    if ((count?.n ?? 0) >= MAX_PRESETS) return bad(`You can keep at most ${String(MAX_PRESETS)} presets.`);
    if (await nameTaken(t, userId, input.name)) return bad(`A preset named "${input.name}" already exists.`);
    const [row] = await t.query<Row>(
      `insert into presets (user_id, name, recipe, pinned, sort) values ($1, $2, $3::jsonb, $4, $5) returning ${COLUMNS}`,
      [userId, input.name, JSON.stringify(input.recipe), input.pinned ?? false, count?.next ?? 0],
    );
    if (row === undefined) throw new Error("preset insert returned nothing");
    await record(deps, t, "preset.created", row.id, { name: input.name, action: input.recipe.action });
    return { ok: true as const, value: toPreset(row) };
  });
}

export async function updatePreset(
  deps: Deps,
  userId: string,
  id: string,
  patch: z.infer<typeof presetPatch>,
): Promise<PresetResult<Preset>> {
  if (!z.uuid().safeParse(id).success) return notFound;
  return deps.db.tx(async (t) => {
    const [current] = await t.query<Row>(`select ${COLUMNS} from presets where id = $1 and user_id = $2`, [
      id,
      userId,
    ]);
    if (current === undefined) return notFound;
    if (patch.name !== undefined && (await nameTaken(t, userId, patch.name, id))) {
      return bad(`A preset named "${patch.name}" already exists.`);
    }
    const [row] = await t.query<Row>(
      `update presets set name = $3, recipe = $4::jsonb, pinned = $5, updated_at = $6 where id = $1 and user_id = $2 returning ${COLUMNS}`,
      [
        id,
        userId,
        patch.name ?? current.name,
        JSON.stringify(patch.recipe ?? current.recipe),
        patch.pinned ?? current.pinned,
        new Date(deps.clock.now()).toISOString(),
      ],
    );
    if (row === undefined) return notFound;
    await record(deps, t, "preset.updated", id, { changed: Object.keys(patch) });
    return { ok: true as const, value: toPreset(row) };
  });
}

export async function deletePreset(deps: Deps, userId: string, id: string): Promise<PresetResult<null>> {
  if (!z.uuid().safeParse(id).success) return notFound;
  return deps.db.tx(async (t) => {
    const gone = await t.query<{ name: string }>(
      "delete from presets where id = $1 and user_id = $2 returning name",
      [id, userId],
    );
    if (gone.length === 0) return notFound;
    await record(deps, t, "preset.deleted", id, { name: gone[0]?.name });
    return { ok: true as const, value: null };
  });
}

/** The owner's order: every preset exactly once. */
export async function reorderPresets(
  deps: Deps,
  userId: string,
  ids: readonly string[],
): Promise<PresetResult<null>> {
  return deps.db.tx(async (t) => {
    const mine = (await t.query<{ id: string }>("select id from presets where user_id = $1", [userId])).map(
      (r) => r.id,
    );
    const sameSet =
      ids.length === mine.length && new Set(ids).size === ids.length && ids.every((i) => mine.includes(i));
    if (!sameSet) return bad("List every preset exactly once.");
    for (const [i, id] of ids.entries()) {
      await t.query("update presets set sort = $3 where id = $1 and user_id = $2", [id, userId, i]);
    }
    await record(deps, t, "preset.reordered", userId, { count: ids.length });
    return { ok: true as const, value: null };
  });
}
