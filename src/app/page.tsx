import { Gauge, ShieldCheck } from "lucide-react";
import { getEnv } from "@/server/env";
import { AppShell, PageHeader, Panel } from "@/ui/AppShell";
import { HaltedBanner } from "@/ui/HaltedBanner";
import { Metric } from "@/ui/Metric";

// Mode and caps come from the runtime env, so this page must never be prerendered at build time.
export const dynamic = "force-dynamic";

/** The desk frame. Live positions, actions and Close All Now land here in Phase 07 M3/M4 (wired to /api/state). */
export default function HomePage() {
  const env = getEnv();
  return (
    <AppShell
      mode={env.TRADING_MODE}
      context={<span className="text-sm text-muted">Sign in to load prices</span>}
    >
      <PageHeader title="Order Desk" subtitle="Many orders, one decision. Every action is previewed first." />

      {env.TRADING_HALTED ? <HaltedBanner /> : null}

      <Panel title="Safety limits per action" meta="server config">
        <dl className="grid grid-cols-3 gap-4">
          <Metric
            label="Orders"
            value={String(env.MAX_ORDERS_PER_ACTION)}
            hint="Most entries one action may open"
          />
          <Metric
            label="Lots"
            value={String(env.MAX_TOTAL_LOTS)}
            hint="Most total lots one action may open"
          />
          <Metric
            label="Risk"
            value={String(env.MAX_RISK_PCT_PER_ACTION)}
            unit="%"
            hint="Most equity at risk to SL, per action"
          />
        </dl>
        <p className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-sm text-muted">
          <Gauge aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.6} />
          <span>
            Spread guard refuses a batch when the spread is over{" "}
            <span className="num text-text">{env.SPREAD_GUARD_K}×</span> its normal level. One modify batch
            touches at most{" "}
            <span className="num text-text">{env.MAX_POSITIONS_PER_BATCH.toLocaleString("en-US")}</span>{" "}
            positions.
          </span>
        </p>
      </Panel>

      <Panel>
        <div className="flex items-start gap-3 text-sm">
          <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" strokeWidth={1.6} />
          <p className="text-muted">
            <span className="text-text">Preview, then confirm.</span> Nothing reaches the broker until you've
            seen exactly what will be sent, and a preview expires after 30 seconds.
          </p>
        </div>
      </Panel>
    </AppShell>
  );
}
