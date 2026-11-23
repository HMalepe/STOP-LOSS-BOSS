import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCsp, newNonce } from "@/server/http/csp";
import { createLogger, REDACTED } from "@/server/logger";
import { Writable } from "node:stream";

const parse = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("CSP", () => {
  it("production: nonce + strict-dynamic, no unsafe-*, no inline anything, locked frames/objects/base", () => {
    const csp = parse(buildCsp("abc123", { dev: false, https: true }));
    expect(csp.get("script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(csp.get("style-src")).toEqual(["'self'", "'nonce-abc123'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
    expect(buildCsp("abc123", { dev: false, https: true })).not.toMatch(/unsafe/);
  });

  it("dev adds only what HMR needs; http skips the upgrade", () => {
    const csp = parse(buildCsp("n", { dev: true, https: false }));
    expect(csp.get("script-src")).toContain("'unsafe-eval'");
    expect(csp.get("style-src")).toContain("'unsafe-inline'");
    expect(csp.get("connect-src")).toContain("ws:");
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
    expect(parse(buildCsp("n", { dev: false, https: false })).has("upgrade-insecure-requests")).toBe(false);
  });

  it("nonces are 128-bit and unique", () => {
    const a = newNonce();
    expect(Buffer.from(a, "base64")).toHaveLength(16);
    expect(new Set(Array.from({ length: 200 }, newNonce)).size).toBe(200);
  });
});

describe("logger redaction, verified end to end on the error path the guard uses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an error carrying the session secret and a cookie header is scrubbed before it's written", () => {
    const secret = "the-session-secret-0123456789abcdefgh";
    const lines: string[] = [];
    const out = new Writable({
      write(chunk: Buffer, _e, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const log = createLogger({ level: "info", secrets: [secret], destination: out });
    log.error(
      {
        err: new Error(`connect failed with ${secret}`),
        req: { headers: { cookie: "__Host-od_session=abc" } },
      },
      "api error",
    );
    const text = lines.join("");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("__Host-od_session=abc");
    expect(text).toContain(REDACTED);
  });
});
