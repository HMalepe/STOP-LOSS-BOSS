/**
 * Runs before every page render (Next 16 "proxy", formerly middleware): a fresh CSP nonce per request.
 * Auth is NOT done here: every API route checks the session itself (src/server/http/guard.ts), so security never depends
 * on this file being matched.
 */
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "./server/http/csp";

export function proxy(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Pages only: not API routes (JSON), not static assets, not prefetches.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icons|manifest|sw.js|offline).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
