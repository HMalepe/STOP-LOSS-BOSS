import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, makeScrubber, REDACTED } from "@/server/logger";

const TOKEN = "mtapi-token-0123456789abcdefghijklmnop";

function capture(secrets: readonly string[] = [TOKEN]) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = createLogger({ level: "info", secrets, destination });
  const all = () => lines.join("");
  const last = () => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  return { logger, all, last };
}

describe("path redaction", () => {
  it.each([
    ["password", { password: "hunter2-hunter2" }],
    ["nested token", { user: { token: "abc-def-ghi-jkl" } }],
    ["cookie header", { req: { headers: { cookie: "sid=s3ss10n-c00kie" } } }],
    ["authorization header", { req: { headers: { authorization: "Bearer xyz-123-456" } } }],
    ["MetaApi auth-token header", { headers: { "auth-token": "header-token-123456" } }],
    ["TOTP code", { totpCode: "123456" }],
    ["recovery codes", { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] }],
    ["env dump key", { env: { SESSION_SECRET: "x".repeat(40) } }],
  ])("masks %s", (_name, payload) => {
    const { logger, all } = capture([]);
    logger.info(payload, "event");
    expect(all()).toContain(REDACTED);
    for (const leaked of [
      "hunter2-hunter2",
      "abc-def-ghi-jkl",
      "s3ss10n-c00kie",
      "xyz-123-456",
      "header-token-123456",
      "123456",
      "aaaa-bbbb",
      "x".repeat(40),
    ]) {
      expect(all()).not.toContain(leaked);
    }
  });
});

describe("value scrubbing (catches what path redaction can't see)", () => {
  it("masks a secret inside a free-text message", () => {
    const { logger, all } = capture();
    logger.info(`calling https://mt-client-api.example/users?auth=${TOKEN}`);
    expect(all()).not.toContain(TOKEN);
    expect(all()).toContain(REDACTED);
  });

  it("masks a secret under an innocent-looking key", () => {
    const { logger, all } = capture();
    logger.info({ request: { url: `https://x/?t=${TOKEN}`, list: ["ok", TOKEN] } }, "req");
    expect(all()).not.toContain(TOKEN);
  });

  it("masks a secret inside an error message and stack, but keeps the error's code", () => {
    const { logger, all, last } = capture();
    const err = Object.assign(new Error(`MetaApi rejected token ${TOKEN}`), { code: 10024 });
    logger.error({ err }, "trade failed");
    expect(all()).not.toContain(TOKEN);
    const logged = last().err as Record<string, unknown>;
    expect(logged.message).toBe(`MetaApi rejected token ${REDACTED}`);
    expect(logged.code).toBe(10024);
    expect(logged.type).toBe("Error");
  });

  it("masks secrets in format arguments", () => {
    const { logger, all } = capture();
    logger.info("token is %s", TOKEN);
    expect(all()).not.toContain(TOKEN);
  });

  it("leaves ordinary logs untouched", () => {
    const { logger, last } = capture();
    logger.info({ planId: "p_123", count: 214, ok: true }, "plan executed");
    expect(last()).toMatchObject({
      planId: "p_123",
      count: 214,
      ok: true,
      msg: "plan executed",
      service: "order-desk",
    });
  });
});

describe("makeScrubber", () => {
  it("is a no-op with no secrets", () => {
    const obj = { a: "b" };
    expect(makeScrubber([])(obj)).toBe(obj);
  });

  it("ignores secrets shorter than 8 chars so it never shreds normal words", () => {
    expect(makeScrubber(["abc"])("abcabc")).toBe("abcabc");
  });

  it("masks the longest overlapping secret whole", () => {
    const scrub = makeScrubber(["secret-part-1", "secret-part-1-and-more"]);
    expect(scrub("x secret-part-1-and-more y")).toBe(`x ${REDACTED} y`);
  });

  it("handles errors without a stack", () => {
    const err = new Error(`boom ${TOKEN}`);
    delete err.stack;
    const out = makeScrubber([TOKEN])(err) as Error;
    expect(out.stack).toBe(`Error: boom ${REDACTED}`);
  });

  it("passes through primitives and stops at a depth limit", () => {
    const scrub = makeScrubber([TOKEN]);
    expect(scrub(42)).toBe(42);
    expect(scrub(null)).toBe(null);
    let deep: unknown = TOKEN;
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(() => scrub(deep)).not.toThrow();
  });
});
