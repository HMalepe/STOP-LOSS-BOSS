import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/ui/api";

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? "nope" : JSON.stringify(body), { status, headers })),
  );

describe("desk API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ok responses come back as data; requests are same-origin, uncached, JSON", async () => {
    const f = reply(200, { mode: "mock" });
    vi.stubGlobal("fetch", f);
    expect(await api.state("XAU USD")).toEqual({ ok: true, data: { mode: "mock" } });
    expect(f).toHaveBeenCalledWith("/api/state?symbol=XAU%20USD", {
      credentials: "same-origin",
      cache: "no-store",
    });
    await api.positions("XAUUSD");
    await api.execute("p1");
    await api.retryFailed("e1");
    await api.closeNow("XAUUSD");
    const [path, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(path).toBe("/api/close-now");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      filter: { symbol: "XAUUSD", side: "ALL" },
      cancelPending: true,
      confirm: "CLOSE",
    });
  });

  it("errors carry the server's code, message and details", async () => {
    vi.stubGlobal(
      "fetch",
      reply(422, { error: { code: "PLAN_INVALID", message: "Nothing to do.", details: [{ id: "1" }] } }),
    );
    expect(await api.preview({ action: "levels" })).toEqual({
      ok: false,
      status: 422,
      code: "PLAN_INVALID",
      message: "Nothing to do.",
      details: [{ id: "1" }],
    });
  });

  it("a non-JSON error body still gives a safe generic message", async () => {
    vi.stubGlobal("fetch", reply(502, undefined));
    expect(await api.state("X")).toEqual({
      ok: false,
      status: 502,
      code: "INTERNAL",
      message: "Something went wrong. Nothing was sent.",
    });
  });

  it("no network → OFFLINE, nothing sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    expect(await api.state("X")).toEqual({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "Can't reach the server. Nothing was sent.",
    });
  });
});

describe("history, kill switch, sessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("paths and bodies", async () => {
    const f = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", f);
    await api.history();
    await api.history("2026-11-23T10:00:00.000Z|abc");
    await api.killSwitch();
    await api.setKillSwitch(true);
    await api.reauth("123456");
    await api.logout();
    await api.revokeAll();
    const paths = f.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(paths).toEqual([
      "/api/history",
      "/api/history?cursor=2026-11-23T10%3A00%3A00.000Z%7Cabc",
      "/api/admin/kill-switch",
      "/api/admin/kill-switch",
      "/api/auth/reauth",
      "/api/auth/logout",
      "/api/auth/sessions/revoke-all",
    ]);
    const body = (i: number) => (f.mock.calls[i] as unknown as [string, RequestInit])[1].body as string;
    expect([JSON.parse(body(3)), JSON.parse(body(4))]).toEqual([{ halted: true }, { code: "123456" }]);
  });
});
