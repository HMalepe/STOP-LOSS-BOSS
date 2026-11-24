"use client";
import { ArrowDownUp, ChevronDown, Crosshair, PackagePlus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { api, type ApiError, type PlanSummary, type Position } from "@/ui/api";
import { AppShell, Panel } from "@/ui/AppShell";
import { ArmButton } from "@/ui/ArmButton";
import { Button } from "@/ui/Button";
import { ConfirmSheet, type SheetPlan } from "@/ui/ConfirmSheet";
import { Connection, type Link } from "@/ui/Connection";
import { cx } from "@/ui/cx";
import { HaltedBanner } from "@/ui/HaltedBanner";
import {
  clockTime,
  parsePrice,
  planSentence,
  signedMoney,
  sortPositions,
  spreadPoints,
  type Ask,
  type SortKey,
} from "@/ui/logic";
import { Metric } from "@/ui/Metric";
import type { Mode } from "@/ui/ModeBadge";
import { PriceInput } from "@/ui/PriceInput";
import { ProgressView } from "@/ui/ProgressView";
import { Segmented } from "@/ui/Segmented";
import { EmptyState, ErrorState } from "@/ui/States";
import { StatusBadge } from "@/ui/StatusBadge";
import { useToast } from "@/ui/Toast";
import { useNow } from "@/ui/useNow";
import { useDeskData, useRun } from "./useDesk";

type Tab = "trigger" | "levels" | "orders" | "helpers";
type Side = "ALL" | "BUY" | "SELL";
interface Pending {
  readonly plan: PlanSummary;
  readonly ask: Ask | null;
}

const SORT_LABEL: Record<SortKey, string> = {
  loss: "Biggest loss first",
  profit: "Biggest profit first",
  ticket: "Oldest first",
};

const fmt = (n: number | null, digits: number) => (n === null ? "—" : n.toFixed(digits));

export function Desk({
  mode,
  symbols,
  initialSymbol,
}: {
  readonly mode: Mode;
  readonly symbols: readonly string[];
  readonly initialSymbol: string;
}) {
  const toast = useToast();
  const now = useNow(500);
  const [symbol, setSymbol] = useState(initialSymbol);
  const { state, positions, error, lastOk, refresh } = useDeskData(symbol);
  const [side, setSide] = useState<Side>("ALL");
  const [profitOnly, setProfitOnly] = useState(false);
  const [tab, setTab] = useState<Tab>("trigger");
  const [sort, setSort] = useState<SortKey>("loss");
  const [trigger, setTrigger] = useState("");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [beOffset, setBeOffset] = useState("0");
  const [lockDist, setLockDist] = useState("100");
  const [previewing, setPreviewing] = useState(false);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [executing, setExecuting] = useState(false);
  const [run, setRun] = useState<{ id: string; total: number } | null>(null);
  const live = useRun(run?.id ?? null, run?.total ?? 0);

  const focus = state?.focus?.symbol === symbol ? state.focus : undefined;
  const digits = focus?.spec.digits ?? 2;
  const halted = state?.killSwitch.halted === true;
  const brokerDown = error !== null && (error.code === "BROKER_UNAVAILABLE" || error.code === "OFFLINE");
  const link: Link = error !== null ? "down" : lastOk !== null && now - lastOk > 3_000 ? "stale" : "live";
  const summary = state?.symbols.find((x) => x.symbol === symbol);
  const pl = summary === undefined ? 0 : summary.buy.profit + summary.sell.profit;
  const count = (summary?.buy.count ?? 0) + (summary?.sell.count ?? 0);
  const allSymbols = useMemo(
    () => [...new Set([...symbols, ...(state?.symbols.map((x) => x.symbol) ?? []), symbol])].sort(),
    [symbols, state, symbol],
  );
  const shown = sortPositions(
    (positions ?? []).filter((p) => (side === "ALL" || p.side === side) && (!profitOnly || p.profit > 0)),
    sort,
  );

  const filter = useMemo(
    () => ({ symbol, side, ...(profitOnly ? { inProfitOnly: true } : {}) }),
    [symbol, side, profitOnly],
  );
  const margin = state?.account.marginLevel ?? null;

  const preview = useCallback(async () => {
    setProblem(null);
    let body: Record<string, unknown>;
    let ask: Ask;
    if (tab === "trigger") {
      if (parsePrice(trigger) === null) {
        setProblem({ status: 400, code: "VALIDATION", message: "Enter the price to close at." });
        return;
      }
      body = { action: "closeAt", filter, price: parsePrice(trigger) };
      ask = { action: "closeAt", price: trigger };
    } else if (tab === "levels") {
      const s = sl === "" ? undefined : parsePrice(sl);
      const t = tp === "" ? undefined : parsePrice(tp);
      if (s === null || t === null) {
        setProblem({ status: 400, code: "VALIDATION", message: "SL and TP must be prices." });
        return;
      }
      if (s === undefined && t === undefined) {
        setProblem({ status: 400, code: "VALIDATION", message: "Enter an SL, a TP, or both." });
        return;
      }
      body = {
        action: "levels",
        filter,
        ...(s === undefined ? {} : { stopLoss: s }),
        ...(t === undefined ? {} : { takeProfit: t }),
      };
      ask = {
        action: "levels",
        ...(s === undefined ? {} : { stopLoss: sl }),
        ...(t === undefined ? {} : { takeProfit: tp }),
      };
    } else {
      return;
    }
    setPreviewing(true);
    const r = await api.preview(body);
    setPreviewing(false);
    if (r.ok) setPending({ plan: r.data, ask });
    else setProblem(r);
  }, [tab, trigger, sl, tp, filter]);

  const helper = async (kind: "breakeven" | "lock") => {
    setProblem(null);
    const n = Number(kind === "breakeven" ? beOffset : lockDist);
    if (!Number.isInteger(n) || n < (kind === "lock" ? 1 : 0)) {
      setProblem({ status: 400, code: "VALIDATION", message: "Points must be a whole number." });
      return;
    }
    setPreviewing(true);
    const r = await api.preview(
      kind === "breakeven"
        ? { action: "breakeven", filter, offsetPoints: n }
        : { action: "lock", filter, distancePoints: n },
    );
    setPreviewing(false);
    if (r.ok) {
      setPending({
        plan: r.data,
        ask:
          kind === "breakeven"
            ? { action: "breakeven", offsetPoints: n }
            : { action: "lock", distancePoints: n },
      });
    } else setProblem(r);
  };

  const confirm = async () => {
    if (pending === null) return;
    setExecuting(true);
    const r = await api.execute(pending.plan.id);
    setExecuting(false);
    if (!r.ok) {
      setPending(null);
      setProblem(r);
      toast(r.code === "PRICE_MOVED" ? "Price moved. Nothing was sent: preview again." : r.message, "error");
      return;
    }
    if (r.data.skipped.length > 0) {
      toast(`${String(r.data.skipped.length)} changed elsewhere since the preview: left alone.`);
    }
    setPending(null);
    setRun({ id: r.data.executionId, total: r.data.count });
  };

  const retry = async () => {
    if (run === null) return;
    const r = await api.retryFailed(run.id);
    if (r.ok) setPending({ plan: r.data, ask: null });
    else toast(r.message, "error");
  };

  const closeAll = async () => {
    const r = await api.closeNow(symbol);
    if (!r.ok) {
      toast(r.message, "error");
      setProblem(r);
      return;
    }
    setRun({ id: r.data.executionId, total: count + (summary?.orders ?? 0) });
    void refresh();
  };

  const sheet: SheetPlan | null =
    pending === null
      ? null
      : {
          sentence:
            pending.ask === null
              ? `Retry ${String(pending.plan.count)} ${pending.plan.symbol} ${pending.plan.count === 1 ? "change" : "changes"} that didn't go through.`
              : planSentence(pending.plan, pending.ask),
          expiresAt: pending.plan.expiresAt,
          count: pending.plan.count,
          breakdown: [
            { label: "Positions", value: String(pending.plan.count) },
            {
              label: "Buys · sells",
              value: `${String(pending.plan.breakdown.buys)} · ${String(pending.plan.breakdown.sells)}`,
            },
            ...(pending.plan.breakdown.asTP === undefined
              ? []
              : [
                  {
                    label: "As take profit",
                    value: String(pending.plan.breakdown.asTP),
                    tone: "up" as const,
                  },
                ]),
            ...(pending.plan.breakdown.asSL === undefined
              ? []
              : [
                  {
                    label: "As stop loss",
                    value: String(pending.plan.breakdown.asSL),
                    tone: "down" as const,
                  },
                ]),
          ],
          warnings: pending.plan.warnings,
          skipped: pending.plan.skipped,
        };

  return (
    <AppShell
      mode={mode}
      context={
        <div className="flex min-w-0 items-center gap-3">
          <label className="relative">
            <span className="sr-only">Symbol</span>
            <select
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value);
                setTrigger("");
                setSl("");
                setTp("");
              }}
              className="num h-9 appearance-none rounded-sm border border-line bg-raised pr-7 pl-2.5 text-sm font-medium text-text focus:border-accent focus:outline-none"
            >
              {allSymbols.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute top-2.5 right-2 size-4 text-muted"
            />
          </label>
          {focus === undefined ? (
            <span className="skeleton h-4 w-24" />
          ) : (
            <span className="num flex min-w-0 items-baseline gap-1.5 text-sm">
              <span className="text-text">{fmt(focus.quote.bid, digits)}</span>
              <span className="hidden text-faint sm:inline">/</span>
              <span className="hidden text-subtle sm:inline">{fmt(focus.quote.ask, digits)}</span>
              <span className="text-xs text-muted">
                {spreadPoints(focus.quote.bid, focus.quote.ask, digits)}pt
              </span>
            </span>
          )}
        </div>
      }
      status={
        <Connection
          state={link}
          {...(lastOk === null || link === "down" ? {} : { age: `${((now - lastOk) / 1000).toFixed(1)}s` })}
        />
      }
      bottom={
        <ArmButton
          label={count === 0 ? `Nothing open on ${symbol}` : "Close all now"}
          armedLabel={`Tap again to close ${String(count)}`}
          onFire={() => void closeAll()}
          disabled={count === 0 && (summary?.orders ?? 0) === 0}
        />
      }
    >
      {halted ? <HaltedBanner /> : null}
      {brokerDown ? (
        <ErrorState
          title="The broker isn't answering"
          body="Nothing can be sent until it's back. Prices refresh by themselves."
          action={
            <Button size="sm" onClick={() => void refresh()}>
              Try now
            </Button>
          }
        />
      ) : null}

      <Panel
        title={symbol}
        meta={state === null ? "loading" : `${String(count)} open · ${String(summary?.orders ?? 0)} pending`}
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
          <Metric
            label="Floating P/L"
            value={signedMoney(pl)}
            unit={state?.account.currency ?? ""}
            trend={pl > 0 ? "up" : pl < 0 ? "down" : "flat"}
            size="lg"
            loading={state === null}
            hint="Profit or loss on this symbol's open positions, net of swap and commission"
          />
          <Metric label="Positions" value={String(count)} loading={state === null} />
          <Metric
            label="Margin level"
            value={margin === null ? "—" : Math.round(margin).toLocaleString("en-US")}
            unit={margin === null ? "" : "%"}
            loading={state === null}
            hint="Equity ÷ used margin. Brokers stop out at a low level"
          />
          <Metric label="Pending" value={String(summary?.orders ?? 0)} loading={state === null} />
        </dl>
      </Panel>

      {pending === null && run !== null ? (
        <ProgressView
          progress={live.progress}
          finished={live.finished}
          items={live.items}
          onRetry={() => void retry()}
          onDone={() => {
            setRun(null);
            void refresh();
          }}
        />
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <Segmented
              label="Which positions"
              value={side}
              onChange={setSide}
              options={[
                { value: "ALL", label: "All" },
                { value: "BUY", label: "Buys" },
                { value: "SELL", label: "Sells" },
              ]}
            />
          </div>
          <button
            type="button"
            aria-pressed={profitOnly}
            onClick={() => {
              setProfitOnly((x) => !x);
            }}
            className={cx(
              "h-12 shrink-0 rounded-md border px-3 text-sm transition-colors",
              profitOnly
                ? "border-up/50 bg-up/10 text-up"
                : "border-line bg-surface text-muted hover:text-subtle",
            )}
          >
            In profit
          </button>
        </div>
        <Segmented
          label="Action"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setProblem(null);
          }}
          options={[
            { value: "trigger", label: "Trigger" },
            { value: "levels", label: "SL/TP" },
            { value: "orders", label: "Orders" },
            { value: "helpers", label: "Helpers" },
          ]}
        />
      </div>

      <Panel>
        {tab === "trigger" ? (
          <div className="flex flex-col gap-4">
            <PriceInput
              label="Close everything at"
              value={trigger}
              onChange={setTrigger}
              digits={digits}
              {...(focus === undefined ? {} : { bid: focus.quote.bid, ask: focus.quote.ask })}
              hint="buys as TP above, SL below"
            />
            <Button
              variant="primary"
              block
              loading={previewing}
              disabled={halted || brokerDown}
              icon={<Crosshair aria-hidden className="size-4" />}
              onClick={() => void preview()}
            >
              Preview
            </Button>
          </div>
        ) : tab === "levels" ? (
          <div className="flex flex-col gap-4">
            <PriceInput
              label="Stop loss"
              optional
              value={sl}
              onChange={setSl}
              digits={digits}
              {...(focus === undefined ? {} : { bid: focus.quote.bid, ask: focus.quote.ask })}
            />
            <PriceInput
              label="Take profit"
              optional
              value={tp}
              onChange={setTp}
              digits={digits}
              {...(focus === undefined ? {} : { bid: focus.quote.bid, ask: focus.quote.ask })}
            />
            <p className="text-xs text-muted">Leave one empty to keep what each position already has.</p>
            <Button
              variant="primary"
              block
              loading={previewing}
              disabled={halted || brokerDown}
              icon={<Crosshair aria-hidden className="size-4" />}
              onClick={() => void preview()}
            >
              Preview
            </Button>
          </div>
        ) : tab === "orders" ? (
          <EmptyState
            icon={<PackagePlus aria-hidden className="size-5" strokeWidth={1.5} />}
            title="Bulk entries arrive with the Order Desk"
            body="Market batches, ladders and cancelling pending orders come in the next phase, each with its own stop."
          />
        ) : (
          <div className="flex flex-col gap-5">
            <HelperRow
              title="Break-even"
              body="Move the SL to entry, plus a few points."
              value={beOffset}
              onChange={setBeOffset}
              unit="pts"
              action="Preview"
              busy={previewing}
              disabled={halted || brokerDown}
              onGo={() => void helper("breakeven")}
            />
            <HelperRow
              title="Lock profit"
              body="SL this many points behind price, on positions in profit."
              value={lockDist}
              onChange={setLockDist}
              unit="pts"
              action="Preview"
              busy={previewing}
              disabled={halted || brokerDown}
              onGo={() => void helper("lock")}
            />
          </div>
        )}
      </Panel>

      {problem === null ? null : <ProblemBox problem={problem} />}

      <Panel
        title="Open positions"
        meta={
          positions === null || lastOk === null
            ? "loading"
            : `${String(shown.length)} shown · as of ${clockTime(lastOk)}`
        }
        actions={
          <button
            type="button"
            onClick={() => {
              setSort((k) => (k === "loss" ? "profit" : k === "profit" ? "ticket" : "loss"));
            }}
            aria-label={`Sorted by ${SORT_LABEL[sort]}. Change sort`}
            className="flex h-8 items-center gap-1.5 rounded-sm px-2 text-xs text-muted transition-colors hover:bg-raised hover:text-text"
          >
            <ArrowDownUp aria-hidden className="size-3.5" />
            {SORT_LABEL[sort]}
          </button>
        }
        flush
      >
        {positions === null ? (
          <div className="flex flex-col gap-3 p-4">
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton h-9 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={positions.length === 0 ? `Nothing open on ${symbol}` : "No positions match the filter"}
          />
        ) : (
          <PositionRows rows={shown} digits={digits} />
        )}
      </Panel>

      {sheet === null ? null : (
        <ConfirmSheet
          plan={sheet}
          mode={mode}
          confirmLabel={`Confirm ${String(sheet.count)}`}
          busy={executing}
          onCancel={() => {
            setPending(null);
          }}
          onExpire={() => {
            setPending(null);
            toast("Preview expired. Nothing was sent.");
          }}
          onConfirm={() => void confirm()}
        />
      )}
    </AppShell>
  );
}

function HelperRow(p: {
  readonly title: string;
  readonly body: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly unit: string;
  readonly action: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onGo: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm font-medium text-text">{p.title}</p>
        <p className="text-xs text-muted">{p.body}</p>
      </div>
      <div className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">{p.title} points</span>
          <input
            inputMode="numeric"
            value={p.value}
            onChange={(e) => {
              p.onChange(e.target.value.replace(/\D/g, ""));
            }}
            className="num min-h-tap w-full rounded-md border border-line-strong bg-surface px-3 pr-12 text-lg text-text focus:border-accent focus:outline-none"
          />
          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">
            {p.unit}
          </span>
        </label>
        <Button variant="primary" loading={p.busy} disabled={p.disabled} onClick={p.onGo}>
          {p.action}
        </Button>
      </div>
    </div>
  );
}

function ProblemBox({ problem }: { readonly problem: ApiError }) {
  const list = Array.isArray(problem.details)
    ? (problem.details as { message?: string; reason?: string; id?: string }[])
        .map((d) => (d.id === undefined ? "" : `#${d.id}: `) + (d.message ?? d.reason ?? ""))
        .filter((x) => x !== "")
    : [];
  return (
    <ErrorState
      title={problem.message}
      {...(list.length === 0
        ? {}
        : {
            action: (
              <ul className="flex flex-col gap-1 text-sm text-subtle">
                {list.slice(0, 6).map((m) => (
                  <li key={m}>· {m}</li>
                ))}
              </ul>
            ),
          })}
    />
  );
}

function PositionRows({ rows, digits }: { readonly rows: readonly Position[]; readonly digits: number }) {
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 px-4 py-3">
          <StatusBadge tone={r.side === "BUY" ? "info" : "neutral"}>
            {r.side === "BUY" ? "Buy" : "Sell"}
          </StatusBadge>
          <div className="min-w-0 flex-1">
            <p className="num text-sm text-text">
              {r.volume.toFixed(2)} <span className="text-muted">@</span> {fmt(r.openPrice, digits)}
              <span className="ml-2 hidden text-xs text-faint sm:inline">#{r.id}</span>
            </p>
            <p className="num text-xs text-muted">
              SL{" "}
              <span className={r.sl === null ? "text-warn" : "text-subtle"}>
                {r.sl === null ? "none" : fmt(r.sl, digits)}
              </span>
              {"  ·  "}TP <span className="text-subtle">{fmt(r.tp, digits)}</span>
            </p>
          </div>
          <span
            className={cx(
              "num text-sm",
              r.profit > 0 ? "text-up" : r.profit < 0 ? "text-down" : "text-muted",
            )}
          >
            {signedMoney(r.profit)}
          </span>
        </li>
      ))}
    </ul>
  );
}
