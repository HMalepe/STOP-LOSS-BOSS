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

/**
 * The client IP. Behind our host's proxy (Railway/Fly) the RIGHT-most X-Forwarded-For entry is the one the proxy added;
 * anything to its left came from the client and can be forged.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const last = xff
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .at(-1);
  return last ?? req.headers.get("x-real-ip") ?? "unknown";
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
