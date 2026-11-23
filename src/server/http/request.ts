/** Reading requests safely: bounded JSON bodies parsed with Zod, the client IP, cookies. */
import type { z } from "zod";

export const MAX_BODY_BYTES = 64 * 1024;

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export async function parseJson<T>(req: Request, schema: z.ZodType<T>): Promise<Parsed<T>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, message: "Request body too large." };
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, message: "Body must be JSON." };
  }
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    message:
      first === undefined
        ? "Invalid request."
        : `${first.path.map(String).join(".") || "body"}: ${first.message}`,
  };
}

/** Headers a hosting proxy sets with the real client IP. Which one is trustworthy depends on the host: TRUSTED_IP_HEADER. */
export const TRUSTED_IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "fly-client-ip",
  "true-client-ip",
] as const;
export type TrustedIpHeader = (typeof TRUSTED_IP_HEADERS)[number];

/**
 * The client IP, read ONLY from the one header our host's proxy is configured to set (any other header is the client's
 * to forge). X-Forwarded-For: the RIGHT-most entry, the one our proxy appended; everything to its left is client-supplied.
 * Missing → "unknown": every such request shares one throttle bucket, which fails closed rather than open.
 */
export function clientIp(req: Request, header: TrustedIpHeader = "x-forwarded-for"): string {
  const raw = req.headers.get(header);
  const value =
    header === "x-forwarded-for"
      ? raw
          ?.split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
          .at(-1)
      : raw?.trim();
  return value === undefined || value === "" ? "unknown" : value.slice(0, 64);
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
