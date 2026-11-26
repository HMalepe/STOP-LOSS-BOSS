/** GET /api/state, GET /api/positions (docs/04). Later milestones add plans, execute, close-now, history. */
import { z } from "zod";
import { BrokerError } from "@/broker/BrokerProvider";
import { killSwitchState } from "@/server/killSwitch";
import { AccountModeError, type TradingServices } from "@/server/trading/services";
import { createEntryPlan, ENTRY_ACTIONS, entryBody, type EntryBody } from "@/server/trading/entryPlans";
import { createPlan, LATER_ACTIONS, loadPlan, planBody, type PlanBody } from "@/server/trading/plans";
import {
  outcomeOf,
  progressView,
  sseFrames,
  startExecution,
  type RecordComplete,
} from "@/server/trading/executions";
import type { Summary } from "@/execution/types";
import type { Sequenced } from "@/execution/jobRunner";
import type { AuthDeps, Session } from "@/server/auth/login";
import { SessionLimiter, type Budget } from "./sessionLimiter";
import { closeNow, closeNowBody, history, retryFailed } from "@/server/trading/manage";
import type { PlanSummary } from "@/server/trading/plans";
import { loadState, pagePositions } from "@/server/trading/state";
import { auditKey, audit } from "@/server/audit/audit";
import type { Db } from "@/server/db/sql";
import type { makeGuard } from "./guard";
import { planErrorResponse } from "./planErrors";
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

export function makeTradingRoutes(
  guard: ReturnType<typeof makeGuard>,
  services: () => Promise<TradingServices>,
  limiter?: SessionLimiter,
) {
  let lim = limiter;
  const throttle = (deps: AuthDeps, session: Session, budget: Budget): Response | null => {
    lim ??= new SessionLimiter(deps.clock);
    const wait = lim.take(session.idHash, budget);
    return wait === 0
      ? null
      : fail("RATE_LIMITED", "Slow down a moment.", {
          headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
        });
  };
  return {
    state: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "read");
      if (limited !== null) return limited;
      const q = query(req, stateQuery);
      if (!q.ok) return fail("VALIDATION", q.message);
      return withBroker(services, async (svc) =>
        ok(await loadState(svc, await killSwitchState(deps.db, svc.envHalted), q.value.symbol)),
      );
    }),

    positions: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "read");
      if (limited !== null) return limited;
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
      const limited = throttle(deps, session, "plan");
      if (limited !== null) return limited;
      const raw = await parseJson(req, z.object({ action: z.string() }).loose());
      if (!raw.ok) return fail("VALIDATION", raw.message);
      if (LATER_ACTIONS.has(raw.value.action)) {
        return fail("VALIDATION", `"${raw.value.action}" arrives with the Order Desk. Not available yet.`);
      }
      const isEntry = ENTRY_ACTIONS.has(raw.value.action);
      const body = isEntry ? entryBody.safeParse(raw.value) : planBody.safeParse(raw.value);
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
        const record = (t: Db, summary: PlanSummary) =>
          audit(
            t,
            auditKey(deps.sessionSecret),
            {
              actor: "owner",
              action: "plan.created",
              subject: summary.id,
              details: {
                action: summary.action,
                symbol: summary.symbol,
                count: summary.count,
                ...(summary.entry === undefined
                  ? {}
                  : {
                      batchSeq: summary.entry.batchSeq ?? null,
                      totalLots: summary.entry.totalLots,
                      risk: summary.entry.risk.total,
                    }),
              },
            },
            new Date(svc.clock.now()),
          );
        const r = isEntry
          ? await createEntryPlan(svc, deps.db, session.userId, body.data as EntryBody, record)
          : await createPlan(svc, deps.db, session.userId, body.data as PlanBody, record);
        if (r.ok) return ok(r.summary, 201);
        return planErrorResponse(r.error);
      });
    }),

    /** GET /api/plans/:id: the stored summary and its exact items. Only the owner's own plans. */
    getPlan: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "read");
        if (limited !== null) return limited;
        const plan = await loadPlan(deps.db, session.userId, id);
        if (plan === null) return fail("NOT_FOUND", "No such plan.");
        const expired = plan.status === "created" && plan.expiresAt <= deps.clock.now();
        return ok({ ...plan.summary, status: expired ? "expired" : plan.status, items: plan.items });
      })(req),

    /** POST /api/plans/:id/execute → 202 { executionId }. Runs the STORED items only; the body is ignored. */
    execute: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "execute");
        if (limited !== null) return limited;
        const plan = await loadPlan(deps.db, session.userId, id);
        if (plan === null) return fail("NOT_FOUND", "No such plan.");
        return withBroker(services, async (svc) => {
          const r = await startExecution(svc, deps.db, plan, completeAudit(deps, svc));
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
        const limited = throttle(deps, session, "read");
        if (limited !== null) return limited;
        const row = await ownedExecution(deps.db, session.userId, id);
        if (row === null) return fail("NOT_FOUND", "No such execution.");
        return withBroker(services, (svc) => {
          const live = svc.runner.status(id);
          const stored = (row.summary ?? {}) as { skippedUpFront?: unknown };
          const skippedUpFront = stored.skippedUpFront ?? [];
          if (live !== undefined) {
            return Promise.resolve(
              ok({
                executionId: id,
                planId: live.planId,
                state: live.state,
                progress: progressView(live.progress),
                skippedUpFront,
                ...(live.summary === undefined
                  ? {}
                  : { outcome: outcomeOf(live.summary), summary: live.summary }),
              }),
            );
          }
          // Not in this process (restart, or pruned): the database has the record. "running" with no live run here
          // can't be true: report it as interrupted (items without a result may have been sent: check MT5).
          const state = row.status === "running" ? "interrupted" : row.status;
          const s = row.summary as Summary | null;
          return Promise.resolve(
            ok({
              executionId: id,
              planId: row.plan_id,
              state,
              skippedUpFront,
              ...(state === "complete" && s !== null && typeof s.total === "number"
                ? { outcome: outcomeOf(s), progress: progressView(s) }
                : {}),
              ...(state === "interrupted" ? { outcome: "interrupted" } : {}),
              summary: row.summary,
            }),
          );
        });
      })(req),

    /**
     * GET /api/executions/:id/stream: Server-Sent Events. Resumes after Last-Event-ID (or ?after=). A heartbeat comment
     * every 15 s keeps proxies from closing a quiet stream. Ends with `complete`, or `error` if the run isn't here.
     */
    stream: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "read");
        if (limited !== null) return limited;
        const row = await ownedExecution(deps.db, session.userId, id);
        if (row === null) return fail("NOT_FOUND", "No such execution.");
        return withBroker(services, (svc) => {
          const lastRaw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after");
          const known = svc.runner.status(id);
          const asked = lastRaw !== null && /^\d{1,9}$/.test(lastRaw) ? Number(lastRaw) : -1;
          if ((openStreams.get(session.idHash) ?? 0) >= MAX_STREAMS_PER_SESSION) {
            return Promise.resolve(
              fail("RATE_LIMITED", "Too many live views open. Close one and try again.", {
                headers: { "Retry-After": "5" },
              }),
            );
          }
          const encoder = new TextEncoder();
          // Every exit path goes through `finish`, exactly once: a dropped client must never leave a timer firing
          // into a cancelled stream (that throws in a timer callback and can take the process down, review H1).
          let closed = false;
          let beat: ReturnType<typeof setInterval> | undefined;
          let lifetime: ReturnType<typeof setTimeout> | undefined;
          let events: AsyncIterator<Sequenced> | undefined;
          let finish: (controller?: ReadableStreamDefaultController<Uint8Array>) => void = () => undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              openStreams.set(session.idHash, (openStreams.get(session.idHash) ?? 0) + 1);
              finish = (c) => {
                if (closed) return;
                closed = true;
                clearInterval(beat);
                clearTimeout(lifetime);
                const n = (openStreams.get(session.idHash) ?? 1) - 1;
                if (n <= 0) openStreams.delete(session.idHash);
                else openStreams.set(session.idHash, n);
                void events?.return?.();
                try {
                  c?.close();
                } catch {
                  // already closed by the client
                }
              };
              const send = (text: string) => {
                if (closed) return;
                try {
                  controller.enqueue(encoder.encode(text));
                } catch {
                  finish();
                }
              };
              req.signal.addEventListener("abort", () => {
                finish();
              });
              beat = setInterval(() => {
                send(": keep-alive\n\n");
              }, 15_000);
              // The phone reconnects with Last-Event-ID, so a capped lifetime loses nothing and bounds every stream.
              lifetime = setTimeout(() => {
                finish(controller);
              }, MAX_STREAM_MS);
              for (const t of [beat, lifetime]) (t as { unref?: () => void }).unref?.();

              if (known?.replayable !== true) {
                send(
                  `event: error\ndata: ${JSON.stringify({
                    code: "NOT_FOUND",
                    message: "This run's live events aren't available. Load its status instead.",
                  })}\n\n`,
                );
                finish(controller);
                return;
              }
              const it = svc.runner.events(id, asked)[Symbol.asyncIterator]();
              events = it;
              void (async () => {
                try {
                  for (;;) {
                    const next = await it.next();
                    if (next.done === true || closed) break;
                    send(sseFrames(next.value.seq, next.value.event));
                  }
                } catch {
                  // the runner never throws here; a bug must still close the stream
                } finally {
                  finish(controller);
                }
              })();
            },
            cancel() {
              finish();
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

    /** POST /api/close-now: build, record and run the close plan in one call, on the urgent lane. */
    closeNow: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "closeNow");
      if (limited !== null) return limited;
      const body = await parseJson(req, closeNowBody);
      if (!body.ok) return fail("VALIDATION", body.message);
      return withBroker(services, async (svc) => {
        const at = new Date(svc.clock.now());
        const r = await closeNow(
          svc,
          deps.db,
          session.userId,
          body.value,
          planAudit(deps, at, "close_now.requested", { cancelPending: body.value.cancelPending }),
          completeAudit(deps, svc),
        );
        if (!r.ok) {
          if (r.code === "NOTHING_TO_CLOSE") return fail("PLAN_INVALID", r.message, { details: [] });
          await audit(
            deps.db,
            auditKey(deps.sessionSecret),
            { actor: "owner", action: "close_now.refused", details: { code: r.code } },
            at,
          );
          return fail(r.code, r.message, r.code === "PRICE_MOVED" ? { details: r.details } : {});
        }
        if ("joined" in r) return ok({ executionId: r.executionId, joined: true }, 202);
        await audit(
          deps.db,
          auditKey(deps.sessionSecret),
          {
            actor: "owner",
            action: "execution.started",
            subject: r.executionId,
            details: { planId: r.summary.id, count: r.summary.count, urgent: true, mode: svc.mode },
          },
          at,
        );
        return ok({ executionId: r.executionId, plan: r.summary }, 202);
      });
    }),

    /** POST /api/executions/:id/retry-failed → a new PlanSummary of the failed items (preview it, then execute it). */
    retryFailed: (req: Request, id: string) =>
      guard.authed({}, async ({ deps, session }) => {
        const limited = throttle(deps, session, "plan");
        if (limited !== null) return limited;
        return withBroker(services, async (svc) => {
          const r = await retryFailed(
            svc,
            deps.db,
            session.userId,
            id,
            planAudit(deps, new Date(svc.clock.now()), "plan.created", { retryOf: id }),
          );
          if (r.ok) return ok(r.summary, 201);
          switch (r.code) {
            case "NOT_FOUND":
              return fail("NOT_FOUND", r.message);
            case "STILL_RUNNING":
            case "NOT_FOR_ENTRIES":
              return fail("VALIDATION", r.message);
            case "NOTHING_TO_RETRY":
              return fail("PLAN_INVALID", r.message, { details: [] });
          }
        });
      })(req),

    /** GET /api/history?cursor= : past executions, newest first. */
    history: guard.authed({}, async ({ req, deps, session }) => {
      const limited = throttle(deps, session, "read");
      if (limited !== null) return limited;
      const cursor = new URL(req.url).searchParams.get("cursor") ?? undefined;
      if (cursor !== undefined && cursor.length > 100) return fail("VALIDATION", "cursor: too long");
      const page = await history(deps.db, session.userId, cursor === "" ? undefined : cursor);
      return page === null ? fail("VALIDATION", "cursor: not a cursor from this list") : ok(page);
    }),
  };
}

/** Live progress streams (security review H1). */
export const MAX_STREAMS_PER_SESSION = 4;
export const MAX_STREAM_MS = 10 * 60_000;
const openStreams = new Map<string, number>();

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

/** The audit writer every plan-storing path shares (same transaction as the plan row). */
function planAudit(
  deps: { readonly db: Db; readonly sessionSecret: string },
  at: Date,
  action: string,
  details: Record<string, unknown> = {},
) {
  return (t: Db, summary: PlanSummary) =>
    audit(
      t,
      auditKey(deps.sessionSecret),
      {
        actor: "owner",
        action,
        subject: summary.id,
        details: { action: summary.action, symbol: summary.symbol, count: summary.count, ...details },
      },
      at,
    );
}

/** Writes a run's completion record into the audit chain (inside the summary's transaction). */
function completeAudit(deps: AuthDeps, svc: TradingServices): RecordComplete {
  return (t, entry) => audit(t, auditKey(deps.sessionSecret), entry, new Date(svc.clock.now()));
}
