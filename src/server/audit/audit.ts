/**
 * Append-only, tamper-evident audit log (CLAUDE.md non-negotiable 4, docs/05).
 * - The database refuses UPDATE/DELETE/TRUNCATE (trigger, 0001_init.sql).
 * - Each row's hash = sha256(prev_hash + canonical row content), so any edit or removed row breaks the chain: verifyChain finds it.
 * - Writes are serialised with a transaction-scoped advisory lock so the chain stays linear.
 * Never put secrets in `details` (the logger's scrubber doesn't run here).
 */
import { sha256 } from "@/server/auth/crypto";
import type { Db } from "@/server/db/sql";

export const GENESIS = "genesis";
const AUDIT_LOCK = 7_731_001;

export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
  readonly subject?: string;
  readonly details?: Record<string, unknown>;
}

/** JSON with keys sorted at every level, so the same content always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

export function rowHash(
  prevHash: string,
  row: { at: string; actor: string; action: string; subject: string | null; details: unknown },
): string {
  return sha256(`${prevHash}|${canonical(row)}`);
}

export async function audit(db: Db, entry: AuditEntry, at: Date = new Date()): Promise<string> {
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock($1)", [AUDIT_LOCK]);
    const [last] = await t.query<{ hash: string }>("select hash from audit_log order by id desc limit 1");
    const prev = last?.hash ?? GENESIS;
    const row = {
      at: at.toISOString(),
      actor: entry.actor,
      action: entry.action,
      subject: entry.subject ?? null,
      details: entry.details ?? {},
    };
    const hash = rowHash(prev, row);
    await t.query(
      "insert into audit_log (at, actor, action, subject, details, prev_hash, hash) values ($1, $2, $3, $4, $5::jsonb, $6, $7)",
      [row.at, row.actor, row.action, row.subject, JSON.stringify(row.details), prev, hash],
    );
    return hash;
  });
}

export type ChainCheck =
  | { readonly ok: true; readonly rows: number }
  | { readonly ok: false; readonly brokenAt: number; readonly reason: string };

/** Recompute the whole chain. Any edited, removed or re-ordered row shows up as the first id where it breaks. */
export async function verifyChain(db: Db): Promise<ChainCheck> {
  const rows = await db.query<{
    id: string | number;
    at: Date | string;
    actor: string;
    action: string;
    subject: string | null;
    details: unknown;
    prev_hash: string;
    hash: string;
  }>("select id, at, actor, action, subject, details, prev_hash, hash from audit_log order by id");
  let prev = GENESIS;
  for (const r of rows) {
    const id = Number(r.id);
    if (r.prev_hash !== prev) {
      return { ok: false, brokenAt: id, reason: "prev_hash does not match the previous row" };
    }
    const at = (r.at instanceof Date ? r.at : new Date(r.at)).toISOString();
    const expected = rowHash(prev, {
      at,
      actor: r.actor,
      action: r.action,
      subject: r.subject,
      details: r.details,
    });
    if (expected !== r.hash) {
      return { ok: false, brokenAt: id, reason: "row content does not match its hash" };
    }
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}
