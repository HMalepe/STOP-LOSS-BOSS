import type { NextConfig } from "next";

// Baseline hardening for every response. The nonce-based CSP is set per request in src/proxy.ts.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Isolate the app from other origins (tab-nabbing, cross-origin reads of our responses).
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Server-only, CommonJS, loaded with require(): never bundle it.
  // metaapi: its "import" condition points at a browser build (see src/broker/metaapi/sdk.ts).
  // pglite + argon2: load their WASM/native files by path; bundled into page chunks they break
  // ("path must be a string… received URL"), so Node loads them as-is.
  serverExternalPackages: ["metaapi.cloud-sdk", "@electric-sql/pglite", "@node-rs/argon2"],
  headers: () => Promise.resolve([{ source: "/:path*", headers: securityHeaders }]),
};

export default config;
