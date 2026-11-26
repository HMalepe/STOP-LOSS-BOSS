/**
 * Presets (docs/11 OD3, docs/03 R9.6). A preset stores a RECIPE, never a price relative to a stale quote:
 * - market recipes are all points (SL/TP from the expected fill) unless the owner typed absolute prices;
 * - ladder recipes store `from` / `to` as signed POINT OFFSETS from the live reference (buy types: ask, sell types: bid), resolved at fire time.
 * Anything with an absolute price is flagged `absolute`, shown as such, and re-validated against the live market by the normal plan builders.
 * Firing builds a fresh plan from the live quote and spec through exactly the same path as a manual action (preview → confirm → execute).
 */
import { z } from "zod";
import { fromPoints, points, toPoints } from "@/domain/price";
import type { Quote, SymbolSpec } from "@/domain/types";
import type { Db } from "../db/sql";
import {
  entryBody,
  expirySpec,
  ladderType,
  levelSpec,
  lotsSpec,
  LOT,
  POINTS,
  PRICE,
  spacingSpec,
  SYMBOL,
  type EntryBody,
} from "./entryPlans";

const offset = z.strictObject({
  mode: z.literal("offset"),
  points: z.number().int().min(-1_000_000).max(1_000_000),
});
const absPrice = z.strictObject({ mode: z.literal("price"), price: PRICE });
const ladderEdge = z.union([offset, absPrice]);

export const marketRecipe = z.strictObject({
  kind: z.literal("market"),
  symbol: SYMBOL,
  side: z.enum(["BUY", "SELL"]),
  count: z.number().int().min(1).max(1_000),
  volume: LOT,
  sl: levelSpec.optional(),
  tp: levelSpec.optional(),
  noStop: z.boolean().optional(),
});

export const ladderRecipe = z.strictObject({
  kind: z.literal("ladder"),
  symbol: SYMBOL,
  type: ladderType,
  from: ladderEdge,
  to: ladderEdge,
  spacing: spacingSpec,
  lots: lotsSpec,
  slPoints: POINTS.optional(),
  tpPoints: POINTS.optional(),
  noStop: z.boolean().optional(),
  expiry: expirySpec,
});

export const recipe = z.discriminatedUnion("kind", [marketRecipe, ladderRecipe]);
export type Recipe = z.infer<typeof recipe>;

export const MAX_PRESETS = 50;
const NAME = z.string().trim().min(1).max(40);

export const presetCreate = z.strictObject({ name: NAME, recipe, pinned: z.boolean().optional() });
export const presetUpdate = z.strictObject({
  name: NAME.optional(),
  recipe: recipe.optional(),
  pinned: z.boolean().optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
});
export const presetFire = z.strictObject({ side: z.enum(["BUY", "SELL"]).optional() });

/** True when the recipe holds an absolute price (flagged in the UI; it can go stale in a way offsets can't). */
export function isAbsolute(r: Recipe): boolean {
  if (r.kind === "market") return r.sl?.mode === "price" || r.tp?.mode === "price";
  return r.from.mode === "price" || r.to.mode === "price";
}

/**
 * R9.6: the recipe → a plan body, from the LIVE quote and spec. Offsets are measured from the live reference price
 * (buy types: ask, sell types: bid). `side` overrides a market recipe's side (the quick-fire BUY/SELL toggle).
 */
export function resolveRecipe(r: Recipe, quote: Quote, spec: SymbolSpec, side?: "BUY" | "SELL"): EntryBody {
  if (r.kind === "market") {
    return entryBody.parse({ action: "market", ...stripKind(r), ...(side === undefined ? {} : { side }) });
  }
  const ref = toPoints(r.type.startsWith("BUY") ? quote.ask : quote.bid, spec);
  const edge = (e: z.infer<typeof ladderEdge>): number =>
    e.mode === "price" ? e.price : fromPoints(points(ref + e.points), spec);
  const { from, to, ...rest } = stripKind(r);
  return entryBody.parse({ action: "ladder", ...rest, from: edge(from), to: edge(to) });
}

function stripKind<T extends { kind: string }>(r: T): Omit<T, "kind"> {
  const copy: Partial<T> = { ...r };
  delete copy.kind;
  return copy as Omit<T, "kind">;
}

export interface PresetRow {
  readonly id: string;
  readonly name: string;
  readonly recipe: Recipe;
  readonly pinned: boolean;
  readonly sort: number;
  readonly absolute: boolean;
  readonly updatedAt: string;
}

interface DbRow {
  id: string;
  name: string;
  recipe: unknown;
  pinned: boolean;
  sort: number;
  updated_at: Date | string;
}

function toRow(r: DbRow): PresetRow | null {
  const parsed = recipe.safeParse(r.recipe);
  if (!parsed.success) return null; // a recipe this version can't read is hidden, never half-run
  return {
    id: r.id,
    name: r.name,
    recipe: parsed.data,
    pinned: r.pinned,
    sort: r.sort,
    absolute: isAbsolute(parsed.data),
    updatedAt: (r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)).toISOString(),
  };
}

const COLS = "id, name, recipe, pinned, sort, updated_at";

export async function listPresets(db: Db, userId: string): Promise<PresetRow[]> {
  const rows = await db.query<DbRow>(
    `select ${COLS} from presets where user_id = $1 order by pinned desc, sort, lower(name)`,
    [userId],
  );
  return rows.map(toRow).filter((r): r is PresetRow => r !== null);
}

export async function getPreset(db: Db, userId: string, id: string): Promise<PresetRow | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.query<DbRow>(`select ${COLS} from presets where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);
  return row === undefined ? null : toRow(row);
}

export type PresetWrite =
  | { readonly ok: true; readonly preset: PresetRow }
  | { readonly ok: false; readonly code: "NAME_TAKEN" | "TOO_MANY" | "NOT_FOUND" };

export async function createPreset(
  db: Db,
  userId: string,
  input: z.infer<typeof presetCreate>,
  now: Date,
  record: (tx: Db, id: string) => Promise<unknown>,
): Promise<PresetWrite> {
  return db.tx(async (t) => {
    const [n] = await t.query<{ n: number }>("select count(*)::int as n from presets where user_id = $1", [
      userId,
    ]);
    if ((n?.n ?? 0) >= MAX_PRESETS) return { ok: false, code: "TOO_MANY" };
    const [dupe] = await t.query("select 1 from presets where user_id = $1 and lower(name) = lower($2)", [
      userId,
      input.name,
    ]);
    if (dupe !== undefined) return { ok: false, code: "NAME_TAKEN" };
    const [{ sort } = { sort: 0 }] = await t.query<{ sort: number }>(
      "select coalesce(max(sort) + 1, 0)::int as sort from presets where user_id = $1",
      [userId],
    );
    const [row] = await t.query<DbRow>(
      `insert into presets (user_id, name, recipe, pinned, sort, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $5, $6, $6) returning ${COLS}`,
      [userId, input.name, JSON.stringify(input.recipe), input.pinned ?? false, sort, now.toISOString()],
    );
    const preset = row === undefined ? null : toRow(row);
    if (preset === null) throw new Error("preset insert returned nothing");
    await record(t, preset.id);
    return { ok: true, preset };
  });
}

export async function updatePreset(
  db: Db,
  userId: string,
  id: string,
  input: z.infer<typeof presetUpdate>,
  now: Date,
  record: (tx: Db) => Promise<unknown>,
): Promise<PresetWrite> {
  if (!z.uuid().safeParse(id).success) return { ok: false, code: "NOT_FOUND" };
  return db.tx(async (t) => {
    const [cur] = await t.query<DbRow>(
      `select ${COLS} from presets where id = $1 and user_id = $2 for update`,
      [id, userId],
    );
    if (cur === undefined) return { ok: false, code: "NOT_FOUND" };
    if (input.name !== undefined) {
      const [dupe] = await t.query(
        "select 1 from presets where user_id = $1 and lower(name) = lower($2) and id <> $3",
        [userId, input.name, id],
      );
      if (dupe !== undefined) return { ok: false, code: "NAME_TAKEN" };
    }
    const [row] = await t.query<DbRow>(
      `update presets set name = $3, recipe = $4::jsonb, pinned = $5, sort = $6, updated_at = $7 where id = $1 and user_id = $2 returning ${COLS}`,
      [
        id,
        userId,
        input.name ?? cur.name,
        JSON.stringify(input.recipe ?? cur.recipe),
        input.pinned ?? cur.pinned,
        input.sort ?? cur.sort,
        now.toISOString(),
      ],
    );
    const preset = row === undefined ? null : toRow(row);
    if (preset === null) throw new Error("preset update returned nothing");
    await record(t);
    return { ok: true, preset };
  });
}

export async function deletePreset(
  db: Db,
  userId: string,
  id: string,
  record: (tx: Db, name: string) => Promise<unknown>,
): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  return db.tx(async (t) => {
    const [gone] = await t.query<{ name: string }>(
      "delete from presets where id = $1 and user_id = $2 returning name",
      [id, userId],
    );
    if (gone === undefined) return false;
    await record(t, gone.name);
    return true;
  });
}
