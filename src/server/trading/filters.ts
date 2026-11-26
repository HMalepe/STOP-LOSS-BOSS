/**
 * The position filter every trading request shares (R4.8), plus `batch` (R9.9): "everything from batch 12" is just a magic number,
 * resolved here so plans, close-now and the batch list can never disagree on what a batch is.
 */
import { z } from "zod";
import { encodeMagic } from "@/domain/batch";
import type { PositionFilter } from "@/domain/types";

export const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");

export const filterShape = z
  .strictObject({
    symbol: SYMBOL,
    side: z.enum(["ALL", "BUY", "SELL"]),
    magic: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    /** A batch number from this app (R9.1). Becomes the magic number; give this OR magic. */
    batch: z.number().int().positive().max(999_999_999).optional(),
    inProfitOnly: z.boolean().optional(),
  })
  .refine((f) => f.magic === undefined || f.batch === undefined, {
    message: "Give magic or batch, not both.",
  });
export type FilterBody = z.infer<typeof filterShape>;

/** Strips `undefined` optionals (exactOptionalPropertyTypes) and turns `batch` into its magic number. */
export function toFilter(f: FilterBody, magicPrefix: number): PositionFilter {
  const magic = f.batch === undefined ? f.magic : encodeMagic(magicPrefix, f.batch);
  return {
    symbol: f.symbol,
    side: f.side,
    ...(magic === undefined ? {} : { magic }),
    ...(f.inProfitOnly === undefined ? {} : { inProfitOnly: f.inProfitOnly }),
  };
}
