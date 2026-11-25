/**
 * R9.1 batch identity (ADR-0005). magic = PREFIX × 10^9 + batchSeq stays below 2^53, so JS numbers are exact.
 * Matching is on magic only; the comment is a human label; clientId (batch + item) is the reconcile key, ALWAYS used
 * together with the magic (a clientId alone is never accepted, review 2026-11-25).
 */
import { invariant } from "./invariant";

export const MAGIC_SPAN = 1_000_000_000;
/** prefix × 10^9 + (10^9 − 1) must be a safe integer. */
export const MAX_PREFIX = 9_007_198;
/** MetaApi: comment + clientId ≤ 26 characters combined (TradeOptions). */
export const COMMENT_CLIENT_ID_MAX = 26;
/** clientId carries a 3-digit item index. */
export const MAX_ITEMS_PER_BATCH = 1_000;

export function encodeMagic(prefix: number, batchSeq: number): number {
  invariant(
    Number.isSafeInteger(prefix) && prefix >= 1 && prefix <= MAX_PREFIX,
    `APP_MAGIC_PREFIX must be 1 to ${String(MAX_PREFIX)}`,
  );
  invariant(
    Number.isSafeInteger(batchSeq) && batchSeq >= 0 && batchSeq < MAGIC_SPAN,
    "batchSeq must be an integer below 10^9",
  );
  return prefix * MAGIC_SPAN + batchSeq;
}

export type DecodedMagic = { readonly app: true; readonly batchSeq: number } | { readonly app: false };

/** Is this magic one of ours, and which batch? Manual trades (0) and other EAs are never "ours". */
export function decodeMagic(magic: number, prefix: number): DecodedMagic {
  if (!Number.isSafeInteger(magic) || magic < MAGIC_SPAN) return { app: false };
  return Math.floor(magic / MAGIC_SPAN) === prefix
    ? { app: true, batchSeq: magic % MAGIC_SPAN }
    : { app: false };
}

export interface BatchTags {
  readonly magic: number;
  readonly comment: string;
  readonly clientId: string;
}

export function batchTags(prefix: number, batchSeq: number, index: number): BatchTags {
  invariant(
    Number.isSafeInteger(index) && index >= 0 && index < MAX_ITEMS_PER_BATCH,
    "item index must be 0 to 999",
  );
  const short = batchSeq.toString(36);
  const tags = {
    magic: encodeMagic(prefix, batchSeq),
    comment: `OD:${short}`,
    clientId: `${short}${String(index).padStart(3, "0")}`,
  };
  invariant(
    tags.comment.length + tags.clientId.length <= COMMENT_CLIENT_ID_MAX,
    "comment + clientId must be ≤ 26 characters (R9.1)",
  );
  return tags;
}
