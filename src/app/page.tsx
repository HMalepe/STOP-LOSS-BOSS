import { getEnv } from "@/server/env";
import { HaltedBanner } from "@/ui/HaltedBanner";
import { ModeBadge } from "@/ui/ModeBadge";
import { Stat } from "@/ui/Stat";

// Mode and caps come from the runtime env, so this page must never be prerendered at build time.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const env = getEnv();

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg/90 px-gutter pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 backdrop-blur">
        <h1 className="text-lg font-bold tracking-tight">Order Desk</h1>
        <ModeBadge mode={env.TRADING_MODE} />
      </header>

      <main className="flex flex-1 flex-col gap-4 px-gutter py-4">
        {env.TRADING_HALTED ? <HaltedBanner /> : null}

        <section aria-labelledby="safety" className="flex flex-col gap-2">
          <h2 id="safety" className="text-xs font-semibold uppercase tracking-wider text-muted">
            Safety limits per action
          </h2>
          <dl className="grid grid-cols-3 gap-2">
            <Stat label="Orders" value={String(env.MAX_ORDERS_PER_ACTION)} />
            <Stat label="Lots" value={String(env.MAX_TOTAL_LOTS)} />
            <Stat label="Risk" value={`${String(env.MAX_RISK_PCT_PER_ACTION)}%`} />
          </dl>
          <p className="text-sm text-muted">
            Spread guard: refuses a batch when the spread is over{" "}
            <span className="num text-text">{env.SPREAD_GUARD_K}×</span> its normal level.
          </p>
        </section>

        <section className="rounded-card border border-line bg-card p-4 text-sm leading-relaxed text-muted">
          <p className="text-text">Foundation build.</p>
          <p>
            No broker is connected and no orders can be sent yet. Trading screens arrive with the domain core
            and broker adapter.
          </p>
        </section>
      </main>
    </div>
  );
}
