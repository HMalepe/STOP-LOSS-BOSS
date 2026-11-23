/** GET /api/state, GET /api/positions (docs/04). Later milestones add plans, execute, close-now, history. */
import { z } from "zod";
import { BrokerError } from "@/broker/BrokerProvider";
import { killSwitchState } from "@/server/killSwitch";
import { AccountModeError, type TradingServices } from "@/server/trading/services";
import { createPlan, LATER_ACTIONS, loadPlan, planBody } from "@/server/trading/plans";
import { progressView, sseFrames, startExecution } from "@/server/trading/executions";
import { loadState, pagePositions } from "@/server/trading/state";
import { auditKey, audit } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import type { makeGuard } from "./guard";
import { fail, ok } from "./respond";
import { parseJson } from "./request";

const SYMBOL = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9._#-]+$/, "not a symbol name");

const stateQuery = z.object({ symbol: SYMBOL.optional() });
const positionsQuery = z.object({
  symbol: SYMBOL.optional(),
  side: z.enum(["ALL", "BUY", "SELL"]).default("ALL"),
  cursor: z.string().max(64).optional(),
});

function query<T>(
  req: Request,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; message: string } {
  const params = Object.fromEntries([...new URL(req.url).searchParams.entries()].filter(([, v]) => v !== ""));
  const r = schema.safeParse(params);
  if (r.success) return { ok: true, value: r.data };
  const first = r.error.issues[0];
  return {
    ok: false,
    message: first === undefined ? "Invalid query." : `${first.path.join(".") || "query"}: ${first.message}`,
  };
}

/** Broker trouble is a 503 with a plain message, never stale data; a wrong account type is refused outright. */
export async function withBroker(
  services: () => Promise<TradingServices>,
  run: (svc: TradingServices) => Promise<Response>,
): Promise<Response> {
  try {
    return await run(await services());
  } catch (e) {
    if (e instanceof AccountModeError) return fail("ACCOUNT_MODE_MISMATCH", e.message);
    if (e instanceof BrokerError) {
      return fail("BROKER_UNAVAILABLE", "The broker isn't answering right now. Nothing was sent.", {
        details: { kind: e.kind },
      });
    }
    throw e;
  }
}

const PLAN_INVALID_EMPTY = "Nothing to do: no open positions match.";

export function makeTradingRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
) {
  return {
    state: guard.authed({}, async ({ req, deps }) => {
      const q = query(req, stateQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      return withBroker(services, async (svc) =>
        ok(await loadState(svc, await killSwitchState(deps.db, svc.envHalted), q.value.symbol)),
      );
    }),

    positions: guard.authed({}, async ({ req }) => {
      const q = query(req, positionsQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      const { symbol, side, cursor } = q.value;
      return withBroker(services, async (svc) =>
        ok(
          pagePositions(
            await svc.broker.getPositions(),
            symbol === undefined ? { side } : { symbol, side },
            cursor,
          ),
        ),
      );
    }),

    /** POST /api/plans: a dry run. Nothing is sent to the broker; the plan is stored for 30 s. */
    createPlan: guard.authed({}, async ({ req, deps, session }) => {
      const raw = await parseJson(req, z.object({ action: z.string() }).loose());
      if (!raw.ok) return fail("VALIDATION", raw.message);
      if (LATER_ACTIONS.has(raw.value.action)) {
        return fail("VALIDATION", `"${raw.value.action}" arrives with the Order Desk. Not available yet.`);
      }
      const body = planBody.safeParse(raw.value);
      if (!body.success) {
        const first = body.error.issues[0];
        return fail(
          "VALIDATION",
          first === undefined
            ? "Invalid plan."
            : `${first.path.map(String).join(".") || "body"}: ${first.message}`,
        );
      }
      return withBroker(services, async (svc) => {
        const r = await createPlan(svc, deps.db, session.userId, body.data, (t, summary) =>
          audit(
            t,
            auditKey(deps.sessionSecret),
            {
              actor: "owner",
              action: "plan.created",
              subject: summary.id,
              details: { action: summary.action, symbol: summary.symbol, count: summary.count },
            },
            new Date(svc.clock.now()),
          ),
        );
        if (r.ok) return ok(r.summary, 201);
        const e = r.error;
        switch (e.code) {
          case "VALIDATION":
            return fail("VALIDATION", e.message);
          case "PRICE_STALE":
            return fail("PRICE_STALE", e.message);
          case "BROKER_UNAVAILABLE":
            return fail("BROKER_UNAVAILABLE", e.message, { details: e.details });
          case "NO_MATCH":
            return fail("PLAN_INVALID", PLAN_INVALID_EMPTY, { details: [] });
          case "PLAN_INVALID":
            return fail("PLAN_INVALID", e.message, { details: e.details });
        }
      });
    }),

    /** GET /api/plans/:id: the stored summary and its exact items. Only the owner's own plans. */
    getPlan: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const plan = await loadPlan(deps.db, session.userId, id);
        if (plan === null) return fail("NOT_FOUND", "No such plan.");
        const expired = plan.status === "created" && plan.expiresAt <= deps.clock.now();
        return ok({ ...plan.summary, status: expired ? "expired" : plan.status, items: plan.items });
      })(req),

    /** POST /api/plans/:id/execute → 202 { executionId }. Runs the STORED items only; the body is ignored. */
    execute: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const plan = await loadPlan(deps.db, session.userId, id);
        if (plan === null) return fail("NOT_FOUND", "No such plan.");
        return withBroker(services, async (svc) => {
          const r = await startExecution(svc, deps.db, plan);
          const key = auditKey(deps.sessionSecret);
          const at = new Date(svc.clock.now());
          if (!r.ok) {
            await audit(
              deps.db,
              key,
              { actor: "owner", action: "execution.refused", subject: plan.id, details: { code: r.code } },
              at,
            );
            const details =
              r.code === "PRICE_MOVED"
                ? r.details
                : r.code === "PLAN_ALREADY_EXECUTED"
                  ? { executionId: r.executionId }
                  : undefined;
            return fail(r.code, r.message, details === undefined ? {} : { details });
          }
          await audit(
            deps.db,
            key,
            {
              actor: "owner",
              action: "execution.started",
              subject: r.executionId,
              details: { planId: plan.id, count: r.count, skippedUpFront: r.skipped.length, mode: svc.mode },
            },
            at,
          );
          return ok({ executionId: r.executionId, count: r.count, skipped: r.skipped }, 202);
        });
      })(req),

    /** GET /api/executions/:id: status, progress, counts. */
    execution: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const row = await ownedExecution(deps.db, session.userId, id);
        if (row === null) return fail("NOT_FOUND", "No such execution.");
        return withBroker(services, (svc) => {
          const live = svc.runner.status(id);
          if (live !== undefined) {
            return Promise.resolve(
              ok({
                executionId: id,
                planId: live.planId,
                state: live.state,
                progress: progressView(live.progress),
                ...(live.summary === undefined ? {} : { summary: live.summary }),
              }),
            );
          }
          // Not in this process any more (restart, or pruned): the database has the record.
          return Promise.resolve(
            ok({ executionId: id, planId: row.plan_id, state: row.status, summary: row.summary }),
          );
        });
      })(req),

    /**
     * GET /api/executions/:id/stream: Server-Sent Events. Resumes after Last-Event-ID (or ?after=). A heartbeat comment
     * every 15 s keeps proxies from closing a quiet stream. Ends with `complete`, or `error` if the run isn't here.
     */
    stream: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const row = await ownedExecution(deps.db, session.userId, id);
        if (row === null) return fail("NOT_FOUND", "No such execution.");
        return withBroker(services, (svc) => {
          const lastRaw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
          const last = lastRaw !== null && /^\d{1,9}$/.test(lastRaw) ? Number(lastRaw) : -1;
          const known = svc.runner.status(id);
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (text: string) => {
                controller.enqueue(encoder.encode(text));
              };
              const beat = setInterval(() => {
                send(": keep-alive\n\n");
              }, 15_000);
              (beat as { unref?: () => void }).unref?.();
              try {
                if (known?.replayable !== true) {
                  send(
                    `event: error\ndata: ${JSON.stringify({
                      code: "NOT_FOUND",
                      message: "This run's live events aren't available. Load its status instead.",
                    })}\n\n`,
                  );
                  return;
                }
                for await (const { seq, event } of svc.runner.events(id, last)) {
                  if (req.signal.aborted) break;
                  send(sseFrames(seq, event));
                }
              } finally {
                clearInterval(beat);
                controller.close();
              }
            },
          });
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              },
            }),
          );
        });
      })(req),
  };
}

async function ownedExecution(
  db: Db,
  userId: string,
  id: string,
): Promise<{ plan_id: string; status: string; summary: unknown } | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await db.query<{ plan_id: string; status: string; summary: unknown }>(
    "select e.plan_id, e.status, e.summary from executions e join plans p on p.id = e.plan_id where e.id = $1 and p.user_id = $2",
    [id, userId],
  );
  return row ?? null;
}
