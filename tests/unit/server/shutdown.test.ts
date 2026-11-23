import { describe, expect, it, vi } from "vitest";
import { Deferred } from "@/execution/channel";
import type { Db } from "@/server/db/sql";
import { shutdown, TaskTracker, type ShutdownTarget } from "@/server/shutdown";

/** Time is driven by hand: `elapse()` fires every pending sleep. */
function clock() {
  const sleeps: Deferred[] = [];
  return {
    sleep: () => {
      const d = new Deferred();
      sleeps.push(d);
      return d.promise;
    },
    elapse: () => {
      for (const d of sleeps.splice(0)) d.resolve();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function target(running: string[] = []) {
  const runIdle = new Deferred();
  if (running.length === 0) runIdle.resolve();
  const log: string[] = [];
  const dbClose = vi.fn((): Promise<void> => (log.push("db.close"), Promise.resolve()));
  const t = {
    runner: {
      stopAccepting: vi.fn(() => log.push("stopAccepting")),
      abortAll: vi.fn((o?: { keepUrgent?: boolean }) => {
        log.push(o?.keepUrgent === true ? "abort normal" : "abort all");
        return o?.keepUrgent === true ? ["n1"] : running;
      }),
      idle: () => runIdle.promise,
      running: () => running,
    },
    background: new TaskTracker(),
    broker: { close: vi.fn(() => (log.push("broker.close"), Promise.resolve())) },
    db: {
      query: vi.fn(() => Promise.resolve([])),
      tx: vi.fn(),
      close: dbClose,
    } as unknown as Db,
    markInterrupted: vi.fn((_db: Db, id: string) => (log.push(`interrupted ${id}`), Promise.resolve(true))),
  } satisfies ShutdownTarget;
  return { t, log, runIdle, dbClose };
}

describe("graceful shutdown", () => {
  it("nothing running: stop accepting, close broker then database, report drained", async () => {
    const { t, log } = target();
    const c = clock();
    const report = await shutdown(t, { sleep: c.sleep });
    expect(log).toEqual(["stopAccepting", "abort normal", "broker.close", "db.close"]);
    expect(report).toEqual({ abortedAtStart: ["n1"], drained: true, interrupted: [], errors: [] });
  });

  it("waits for result writes (background) before closing the database", async () => {
    const { t, log } = target();
    const c = clock();
    const write = new Deferred();
    t.background.track(write.promise);
    const done = shutdown(t, { sleep: c.sleep });
    await flush();
    expect(log).not.toContain("db.close");
    write.resolve();
    expect((await done).drained).toBe(true);
    expect(log.at(-1)).toBe("db.close");
  });

  it("drain deadline passes: abort everything (close-now too), short grace, mark leftovers interrupted, still close", async () => {
    const { t, log } = target(["u1"]);
    const c = clock();
    const done = shutdown(t, { sleep: c.sleep, drainMs: 15_000, graceMs: 2_000 });
    await flush();
    c.elapse(); // drain deadline
    await flush();
    c.elapse(); // grace deadline
    const report = await done;
    expect(log).toEqual([
      "stopAccepting",
      "abort normal",
      "abort all",
      "interrupted u1",
      "broker.close",
      "db.close",
    ]);
    expect(report).toMatchObject({ drained: false, interrupted: ["u1"], errors: [] });
  });

  it("a failing or hanging close never stops the rest; errors are reported, not thrown", async () => {
    const { t, dbClose } = target();
    const c = clock();
    t.broker.close.mockImplementation(() => new Promise<void>(() => undefined));
    dbClose.mockRejectedValue(new Error("gone"));
    const done = shutdown(t, { sleep: c.sleep });
    await flush();
    c.elapse(); // broker close timeout
    const report = await done;
    expect(report.errors).toEqual(["broker close timed out", "database close: gone"]);
  });

  it("services never started: nothing to drain, resolves cleanly", async () => {
    expect(await shutdown(undefined, { sleep: clock().sleep })).toEqual({
      abortedAtStart: [],
      drained: true,
      interrupted: [],
      errors: [],
    });
  });
});

describe("TaskTracker", () => {
  it("idle waits for every tracked task, including ones added while waiting; failures don't reject", async () => {
    const tr = new TaskTracker();
    await tr.idle();
    const a = new Deferred();
    const b = new Deferred();
    tr.track(a.promise);
    let idle = false;
    void tr.idle().then(() => (idle = true));
    tr.track(b.promise);
    tr.track(Promise.reject(new Error("x")));
    a.resolve();
    await flush();
    expect(idle).toBe(false);
    b.resolve();
    await flush();
    expect(idle).toBe(true);
    expect(tr.size).toBe(0);
  });
});
