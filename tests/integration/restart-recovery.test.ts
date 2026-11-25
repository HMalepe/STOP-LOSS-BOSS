/**
 * Restart recovery (PROGRESS carry-over): every item is "pending" from the claim, "sending" right before its first broker
 * call, then its result. After a crash, boot recovery can tell "never sent" (safe to retry) from "maybe sent" (unknown).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanItem } from "@/domain/types";
import { makeTradingRoutes } from "@/server/http/tradingRoutes";
import { DbExecutionStore, recoverInterrupted } from "@/server/trading/executions";
import type { TradingServices } from "@/server/trading/services";
import { mockServices } from "../helpers/services";
import { post, signedIn, type SignedIn } from "../helpers/session";

let s: SignedIn;
let svc: TradingServices;
let routes: ReturnType<typeof makeTradingRoutes>;

beforeEach(async () => {
  s = await signedIn();
  ({ svc } = mockServices(s.db, s.clock));
  routes = makeTradingRoutes(s.guard, () => Promise.resolve(svc));
});
afterEach(async () => {
  await s.db.close();
});

type Json = Record<string, unknown>;
const EX = "00000000-0000-4000-8000-0000000000e1";

async function preview(): Promise<{ id: string; items: PlanItem[] }> {
  const res = await routes.createPlan(
    post(
      "/api/plans",
      { action: "levels", filter: { symbol: "XAUUSD", side: "BUY" }, takeProfit: 2700 },
      s.cookie,
    ),
  );
  const id = String(((await res.json()) as Json).id);
  const [row] = await s.db.query<{ items: PlanItem[] }>("select items from plans where id = $1", [id]);
  return { id, items: row?.items ?? [] };
}
const items = (executionId: string) =>
  s.db.query<{ idx: number; op: string; target_id: string; state: string; message: string | null }>(
    "select idx, op, target_id, state, message from execution_items where execution_id = $1 order by idx",
    [executionId],
  );
async function settle(executionId: string): Promise<void> {
  for await (const { event } of svc.runner.events(executionId)) if (event.type === "complete") break;
  for (let i = 0; i < 200; i++) {
    const [row] = await s.db.query<{ status: string }>("select status from executions where id = $1", [
      executionId,
    ]);
    if (row?.status !== "running") return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("intent rows", () => {
  it("the claim writes every item as pending, in the same step; a losing claim writes nothing", async () => {
    const plan = await preview();
    expect(plan.items.length).toBeGreaterThanOrEqual(2);
    const store = new DbExecutionStore(s.db, s.clock);
    expect(await store.claim(plan.id, EX, plan.items)).toEqual({ executionId: EX, created: true });
    const rows = await items(EX);
    expect(rows.map((r) => [r.idx, r.op, r.state])).toEqual(
      plan.items.map((i, idx) => [idx, i.op, "pending"]),
    );
    expect(rows.map((r) => r.target_id)).toEqual(
      plan.items.map((i) => (i.op === "cancel" ? i.orderId : i.positionId)),
    );
    const again = await store.claim(plan.id, "00000000-0000-4000-8000-0000000000e2", plan.items);
    expect(again).toEqual({ executionId: EX, created: false });
    expect(await s.db.query("select count(*)::int as n from execution_items")).toEqual([
      { n: plan.items.length },
    ]);
  });

  it("markSending flips exactly that item to sending", async () => {
    const plan = await preview();
    const store = new DbExecutionStore(s.db, s.clock);
    await store.claim(plan.id, EX, plan.items);
    await store.markSending(EX, 1);
    expect((await items(EX)).map((r) => r.state)).toEqual(
      plan.items.map((_, i) => (i === 1 ? "sending" : "pending")),
    );
  });

  it("a real run leaves no pending or sending rows behind", async () => {
    const plan = await preview();
    const { executionId } = (await (
      await routes.execute(post(`/api/plans/${plan.id}/execute`, {}, s.cookie), plan.id)
    ).json()) as { executionId: string };
    await settle(executionId);
    const rows = await items(executionId);
    expect(rows).toHaveLength(plan.items.length);
    expect(rows.every((r) => r.state === "done")).toBe(true);
  });
});

describe("boot recovery after a crash mid-batch", () => {
  it("pending → skipped 'not sent' (retryable); sending → unknown (check MT5, never retried); results untouched", async () => {
    const plan = await preview();
    const store = new DbExecutionStore(s.db, s.clock);
    await store.claim(plan.id, EX, plan.items);
    await store.markSending(EX, 1);
    await s.db.query(
      "update execution_items set state = 'done', message = 'ok' where execution_id = $1 and idx = 0",
      [EX],
    );
    // idx 0 done, idx 1 sending, the rest pending. The process dies here.

    expect(await recoverInterrupted(s.db, () => false)).toEqual([EX]);
    const rows = await items(EX);
    expect(rows[0]).toMatchObject({ state: "done", message: "ok" });
    expect(rows[1]).toMatchObject({ state: "unknown" });
    expect(rows[1]?.message).toMatch(/restarted while sending.*MT5/);
    for (const r of rows.slice(2)) {
      expect(r).toMatchObject({ state: "skipped", message: expect.stringMatching(/^not sent: /) as unknown });
    }

    const res = await routes.retryFailed(post(`/api/executions/${EX}/retry-failed`, {}, s.cookie), EX);
    const pendingCount = plan.items.length - 2;
    if (pendingCount === 0) {
      expect(res.status).toBe(422);
      return;
    }
    expect(res.status).toBe(201);
    const summary = (await res.json()) as { warnings: string[]; id: string };
    expect(summary.warnings).toEqual([
      `Retrying ${String(pendingCount)} that failed or weren't sent.`,
      "1 ended unknown and are NOT retried: check them in MT5.",
    ]);
  });

  it("the retry route's own interrupted path resolves leftovers the same way", async () => {
    const plan = await preview();
    const store = new DbExecutionStore(s.db, s.clock);
    await store.claim(plan.id, EX, plan.items);
    await store.markSending(EX, 0);
    const res = await routes.retryFailed(post(`/api/executions/${EX}/retry-failed`, {}, s.cookie), EX);
    expect((await items(EX)).map((r) => r.state)).toEqual(
      plan.items.map((_, i) => (i === 0 ? "unknown" : "skipped")),
    );
    expect(res.status).toBe(201);
  });
});

describe("after a restart: entries caught mid-send are looked up by clientId (ADR-0009)", () => {
  it("found as a position or order → done (with the ticket); not found or in flight → stays unknown, said so", async () => {
    const { reconcileRestartedEntries, UNKNOWN_RESTART } = await import("@/server/trading/executions");
    const { broker } = mockServices(s.db, s.clock);
    const plan = await preview();
    await new DbExecutionStore(s.db, s.clock).claim(plan.id, EX, []);
    const tag = { magic: 7_731_000_000_777, comment: "OD:lr" };
    // The stored plan is where recovery reads each entry's batch magic from (R9.1).
    await s.db.query("update plans set items = $2::jsonb where id = $1", [
      plan.id,
      JSON.stringify(
        ["lr0", "lr1", "lr2", "lr3"].map((clientId) => ({ op: "market", clientId, magic: tag.magic })),
      ),
    ]);
    await broker.placeMarket({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      sl: 1.08,
      tp: null,
      ...tag,
      clientId: "lr0",
    });
    await broker.placePending({
      symbol: "EURUSD",
      type: "BUY_LIMIT",
      volume: 0.01,
      openPrice: 1.08,
      sl: 1.07,
      tp: null,
      ...tag,
      clientId: "lr1",
    });
    broker.setInFlight("lr3", true, tag.magic);
    const rows: [number, string, string][] = [
      [0, "market", "lr0"],
      [1, "pending", "lr1"],
      [2, "market", "lr2"],
      [3, "market", "lr3"],
    ];
    for (const [idx, op, target] of rows) {
      await s.db.query(
        "insert into execution_items (execution_id, idx, op, target_id, state, message) values ($1, $2, $3, $4, 'unknown', $5)",
        [EX, idx, op, target, UNKNOWN_RESTART],
      );
    }

    expect(await reconcileRestartedEntries(s.db, broker)).toEqual({ checked: 4, found: 2 });
    const after = await items(EX);
    expect(after.map((r) => r.state)).toEqual(["done", "done", "unknown", "unknown"]);
    expect(after[0]?.message).toMatch(/^found in MT5 after a restart: position \d+/);
    expect(after[1]?.message).toMatch(/^found in MT5 after a restart: order \d+/);
    expect(after[2]?.message).toMatch(/not found in MT5 after a restart/);
    expect(after[3]?.message).toMatch(/still being processed/);
    // Idempotent: a second boot finds nothing new to check.
    expect(await reconcileRestartedEntries(s.db, broker)).toEqual({ checked: 0, found: 0 });
  });

  it("R9.1: another batch's order with the SAME clientId is not mistaken for ours (lost entry stays unknown)", async () => {
    const { reconcileRestartedEntries, UNKNOWN_RESTART } = await import("@/server/trading/executions");
    const { broker } = mockServices(s.db, s.clock);
    const plan = await preview();
    await new DbExecutionStore(s.db, s.clock).claim(plan.id, EX, []);
    await s.db.query("update plans set items = $2::jsonb where id = $1", [
      plan.id,
      JSON.stringify([{ op: "market", clientId: "a010", magic: 7_731_000_000_010 }]),
    ]);
    // A DIFFERENT batch (magic ...361) has an open position carrying the very same clientId.
    await broker.placeMarket({
      symbol: "EURUSD",
      side: "BUY",
      volume: 0.01,
      sl: 1.08,
      tp: null,
      magic: 7_731_000_000_361,
      comment: "OD:a1",
      clientId: "a010",
    });
    await s.db.query(
      "insert into execution_items (execution_id, idx, op, target_id, state, message) values ($1, 0, 'market', 'a010', 'unknown', $2)",
      [EX, UNKNOWN_RESTART],
    );
    expect(await reconcileRestartedEntries(s.db, broker)).toEqual({ checked: 1, found: 0 });
    expect((await items(EX))[0]?.state).toBe("unknown");
  });

  it("an item whose stored plan has no magic can't be matched safely: left unknown, never guessed", async () => {
    const { reconcileRestartedEntries, UNKNOWN_RESTART } = await import("@/server/trading/executions");
    const { broker } = mockServices(s.db, s.clock);
    const plan = await preview();
    await new DbExecutionStore(s.db, s.clock).claim(plan.id, EX, []);
    await s.db.query(
      "insert into execution_items (execution_id, idx, op, target_id, state, message) values ($1, 0, 'market', 'z', 'unknown', $2)",
      [EX, UNKNOWN_RESTART],
    );
    expect(await reconcileRestartedEntries(s.db, broker)).toEqual({ checked: 0, found: 0 });
  });

  it("a broker that can't answer changes nothing and never throws", async () => {
    const { reconcileRestartedEntries, UNKNOWN_RESTART } = await import("@/server/trading/executions");
    const { broker } = mockServices(s.db, s.clock);
    const plan = await preview();
    await new DbExecutionStore(s.db, s.clock).claim(plan.id, EX, []);
    await s.db.query("update plans set items = $2::jsonb where id = $1", [
      plan.id,
      JSON.stringify([{ op: "market", clientId: "z0", magic: 7_731_000_000_001 }]),
    ]);
    await s.db.query(
      "insert into execution_items (execution_id, idx, op, target_id, state, message) values ($1, 0, 'market', 'z0', 'unknown', $2)",
      [EX, UNKNOWN_RESTART],
    );
    broker.setConnected(false);
    expect(await reconcileRestartedEntries(s.db, broker)).toEqual({ checked: 0, found: 0 });
    expect((await items(EX))[0]?.message).toBe(UNKNOWN_RESTART);
  });
});
