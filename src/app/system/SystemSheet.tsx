"use client";
import { ArrowRight, CircleCheck, Crosshair, ShieldAlert, Zap } from "lucide-react";
import { useState } from "react";
import { AppShell, PageHeader, Panel } from "@/ui/AppShell";
import { Button } from "@/ui/Button";
import { Connection } from "@/ui/Connection";
import { HaltedBanner } from "@/ui/HaltedBanner";
import { Metric } from "@/ui/Metric";
import { ModeBadge, type Mode } from "@/ui/ModeBadge";
import { Segmented } from "@/ui/Segmented";
import { EmptyState, ErrorState, OfflineBanner } from "@/ui/States";
import { StatusBadge } from "@/ui/StatusBadge";
import { ToastProvider } from "@/ui/Toast";
import { ControlsDemo } from "./ControlsDemo";

const SWATCHES = [
  ["ink", "bg-ink"],
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["raised", "bg-raised"],
  ["overlay", "bg-overlay"],
  ["line", "bg-line"],
  ["accent", "bg-accent"],
  ["up", "bg-up"],
  ["down", "bg-down"],
  ["warn", "bg-warn"],
  ["info", "bg-info"],
  ["danger", "bg-danger"],
] as const;

/** SAMPLE rows: shaped like GET /api/positions, clearly not live. */
const ROWS = [
  { id: "50213", side: "BUY", lots: 0.1, open: 2641.5, sl: null, tp: 2700.0, pl: 87.6 },
  { id: "50214", side: "SELL", lots: 0.1, open: 2645.2, sl: 2660.0, tp: null, pl: -51.0 },
  { id: "50215", side: "BUY", lots: 0.25, open: 2648.9, sl: 2630.0, tp: 2700.0, pl: 30.0 },
  { id: "50216", side: "SELL", lots: 0.1, open: 2652.4, sl: null, tp: null, pl: 21.0 },
] as const;

const price = (n: number | null) => (n === null ? "—" : n.toFixed(2));

export function SystemSheet({ mode }: { readonly mode: Mode }) {
  const [tab, setTab] = useState<"trigger" | "levels" | "orders" | "helpers">("trigger");
  const [side, setSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  return (
    <ToastProvider>
      <AppShell
        mode={mode}
        context={
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="num text-sm font-medium text-text">XAUUSD</span>
            <span className="num hidden text-sm text-subtle sm:inline">
              2650.10 <span className="text-faint">/</span> 2650.30
            </span>
            <span className="num text-xs text-muted">20 pt</span>
          </div>
        }
        status={<Connection state="live" age="0.4s" />}
        bottom={
          <Button variant="panic" block icon={<Zap aria-hidden className="size-4" strokeWidth={2.25} />}>
            Close all now
          </Button>
        }
      >
        <PageHeader
          title="Design system"
          subtitle="The Observatory: quiet, engineered, legible under pressure."
          actions={<StatusBadge tone="warn">Sample data</StatusBadge>}
        />

        <Panel title="Account" meta="XAUUSD · 5 positions · sample">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
            <Metric
              label="Floating P/L"
              value="+87.60"
              unit="USD"
              trend="up"
              size="lg"
              hint="Profit or loss on open positions, net of swap and commission"
            />
            <Metric label="Positions" value="5" hint="Open positions on this symbol" />
            <Metric
              label="Margin level"
              value="1,842"
              unit="%"
              hint="Equity ÷ used margin. Brokers stop out at a low level"
            />
            <Metric label="Pending" value="1" hint="Pending orders on this symbol" />
          </dl>
        </Panel>

        <div className="flex flex-col gap-3">
          <Segmented
            label="Filter positions by side"
            value={side}
            onChange={setSide}
            options={[
              { value: "ALL", label: "All" },
              { value: "BUY", label: "Buys" },
              { value: "SELL", label: "Sells" },
            ]}
          />
          <Segmented
            label="Action"
            value={tab}
            onChange={setTab}
            options={[
              { value: "trigger", label: "Trigger" },
              { value: "levels", label: "SL/TP" },
              { value: "orders", label: "Orders" },
              { value: "helpers", label: "Helpers" },
            ]}
          />
        </div>

        <Panel title="Open positions" meta="sample · sorted by exposure" flush>
          {/* Phone: one position per row, the numbers that matter first. No sideways scrolling. */}
          <ul className="divide-y divide-line/60 sm:hidden">
            {ROWS.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <StatusBadge tone={r.side === "BUY" ? "info" : "neutral"}>
                  {r.side === "BUY" ? "Buy" : "Sell"}
                </StatusBadge>
                <div className="min-w-0 flex-1">
                  <p className="num text-sm text-text">
                    {r.lots.toFixed(2)} <span className="text-muted">@</span> {price(r.open)}
                  </p>
                  <p className="num text-xs text-muted">
                    SL{" "}
                    <span className={r.sl === null ? "text-warn" : "text-subtle"}>
                      {r.sl === null ? "none" : price(r.sl)}
                    </span>
                    {"  ·  "}TP <span className="text-subtle">{price(r.tp)}</span>
                  </p>
                </div>
                <span className={`num text-sm ${r.pl >= 0 ? "text-up" : "text-down"}`}>
                  {r.pl >= 0 ? "+" : "−"}
                  {Math.abs(r.pl).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Open positions (sample data)</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  {["Ticket", "Side", "Lots", "Open", "SL", "TP", "P/L"].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`eyebrow px-4 py-2.5 font-medium ${i >= 2 ? "text-right" : ""}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-raised/40">
                    <td className="num px-4 py-3 text-muted">#{r.id}</td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={r.side === "BUY" ? "info" : "neutral"}>
                        {r.side === "BUY" ? "Buy" : "Sell"}
                      </StatusBadge>
                    </td>
                    <td className="num px-4 py-3 text-right">{r.lots.toFixed(2)}</td>
                    <td className="num px-4 py-3 text-right text-subtle">{price(r.open)}</td>
                    <td className={`num px-4 py-3 text-right ${r.sl === null ? "text-warn" : "text-subtle"}`}>
                      {r.sl === null ? "none" : price(r.sl)}
                    </td>
                    <td className="num px-4 py-3 text-right text-subtle">{price(r.tp)}</td>
                    <td className={`num px-4 py-3 text-right ${r.pl >= 0 ? "text-up" : "text-down"}`}>
                      {r.pl >= 0 ? "+" : "−"}
                      {Math.abs(r.pl).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <ControlsDemo mode={mode} />

        <Panel title="Buttons" meta="48 px targets · every state">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Button variant="primary" icon={<Crosshair aria-hidden className="size-4" />}>
              Preview
            </Button>
            <Button>Use bid</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Close 214</Button>
            <Button variant="primary" loading>
              Sending
            </Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">−10 pt</Button>
            <Button size="sm">+10 pt</Button>
          </div>
        </Panel>

        <Panel title="Status language" meta="never colour alone">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {(["mock", "demo", "live"] as const).map((m) => (
                <ModeBadge key={m} mode={m} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="up" icon={<CircleCheck aria-hidden className="size-3.5" />}>
                Done 212
              </StatusBadge>
              <StatusBadge tone="down">Failed 2</StatusBadge>
              <StatusBadge tone="warn">Unknown 0</StatusBadge>
              <StatusBadge tone="accent">Preview · 24s</StatusBadge>
              <StatusBadge>Skipped 3</StatusBadge>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Connection state="live" age="0.4s" />
              <Connection state="stale" age="6s" />
              <Connection state="down" />
            </div>
          </div>
        </Panel>

        <Panel title="Type" meta="Geist · tabular numerals">
          <div className="flex flex-col gap-3">
            <p className="text-xl font-semibold tracking-tight">Page title, 20 / semibold</p>
            <p className="text-[0.9375rem]">
              Body, 15. Plain sentences: 214 positions will close at 2650.00.
            </p>
            <p className="text-sm text-muted">Secondary, 14, cool muted.</p>
            <p className="eyebrow">Eyebrow label, 11 / tracked</p>
            <p className="num text-[1.75rem] font-medium tracking-tight">2650.10 · 1.08611</p>
          </div>
        </Panel>

        <Panel title="Palette" meta="tokens in globals.css">
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {SWATCHES.map(([name, cls]) => (
              <li key={name} className="flex flex-col gap-1.5">
                <span className={`h-10 rounded-md border border-line-strong ${cls}`} />
                <span className="num text-2xs text-muted">{name}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="flex flex-col gap-3">
          <p className="eyebrow">States</p>
          <HaltedBanner />
          <ErrorState
            title="The broker isn't answering"
            body="Nothing was sent. Prices will refresh when the connection is back."
            action={
              <Button size="sm" icon={<ArrowRight aria-hidden className="size-4" />}>
                Try again
              </Button>
            }
          />
          <div className="panel overflow-hidden">
            <OfflineBanner />
            <EmptyState title="No open positions" body="Nothing to manage on XAUUSD right now." />
          </div>
          <Panel title="Loading" meta="skeletons, never spinners for layout">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric label="Floating P/L" value="" loading size="lg" />
              <Metric label="Positions" value="" loading />
              <Metric label="Margin level" value="" loading />
              <Metric label="Pending" value="" loading />
            </dl>
          </Panel>
          <div className="flex items-start gap-3 rounded-card border border-warn/40 bg-warn/8 p-4 text-sm">
            <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warn" strokeWidth={1.75} />
            <p className="text-subtle">
              <span className="font-medium text-warn">Mixed sides at one price.</span> Buys close on the bid
              and sells on the ask, so they won't trigger at the same instant.
            </p>
          </div>
        </div>
      </AppShell>
    </ToastProvider>
  );
}
