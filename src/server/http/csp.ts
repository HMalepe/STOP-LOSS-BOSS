/**
 * Content-Security-Policy (docs/05: strict CSP, no inline script, nonce). Built per request by src/proxy.ts.
 * Next.js reads the nonce from this header and attaches it to its own scripts (Next 16 CSP guide).
 */
export interface CspOptions {
  readonly dev: boolean;
  /** Only send upgrade-insecure-requests where the site is served over https. */
  readonly https: boolean;
}

export function buildCsp(nonce: string, opts: CspOptions): string {
  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    // Only scripts carrying this request's nonce run; 'strict-dynamic' lets those load Next's chunks. Dev needs eval for HMR.
    ["script-src", "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(opts.dev ? ["'unsafe-eval'"] : [])],
    // Tailwind compiles to a stylesheet; the dev overlay injects inline styles.
    ["style-src", "'self'", ...(opts.dev ? ["'unsafe-inline'"] : [`'nonce-${nonce}'`])],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    // The phone only ever talks to this server (API + SSE). Dev HMR uses a websocket to the same host.
    ["connect-src", "'self'", ...(opts.dev ? ["ws:"] : [])],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["manifest-src", "'self'"],
    ["worker-src", "'self'"],
  ];
  if (opts.https && !opts.dev) directives.push(["upgrade-insecure-requests"]);
  return directives.map((d) => d.join(" ")).join("; ");
}

/** 128 random bits, base64. Unpredictable and unique per request (the whole point of a nonce). */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
