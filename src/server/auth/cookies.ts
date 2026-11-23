/**
 * Auth cookies (docs/05): HttpOnly, Secure, SameSite=Strict. The __Host- prefix makes the browser refuse the cookie unless
 * it's Secure, Path=/ and has no Domain, so a subdomain can never plant or read it.
 */
export const SESSION_COOKIE = "__Host-od_session";
export const PENDING_COOKIE = "__Host-od_pending";

export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${String(Math.max(0, Math.floor(maxAgeSec)))}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
