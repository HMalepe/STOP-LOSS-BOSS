import { getEnv } from "@/server/env";
import { requireSession } from "@/server/http/pageSession";
import { AppShell, PageHeader } from "@/ui/AppShell";
import { ToastProvider } from "@/ui/Toast";
import { SettingsPanel } from "./SettingsPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireSession();
  const env = getEnv();
  return (
    <ToastProvider>
      <AppShell mode={env.TRADING_MODE}>
        <PageHeader title="Settings" subtitle="Kill switch, limits and sign-in." />
        <SettingsPanel
          mode={env.TRADING_MODE}
          limits={{
            orders: env.MAX_ORDERS_PER_ACTION,
            lots: env.MAX_TOTAL_LOTS,
            riskPct: env.MAX_RISK_PCT_PER_ACTION,
            perBatch: env.MAX_POSITIONS_PER_BATCH,
            spreadK: env.SPREAD_GUARD_K,
          }}
        />
      </AppShell>
    </ToastProvider>
  );
}
