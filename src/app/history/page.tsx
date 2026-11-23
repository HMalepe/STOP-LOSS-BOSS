import { History } from "lucide-react";
import { getEnv } from "@/server/env";
import { requireSession } from "@/server/http/pageSession";
import { AppShell, PageHeader, Panel } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requireSession();
  return (
    <AppShell mode={getEnv().TRADING_MODE}>
      <PageHeader title="History" subtitle="Every batch you've run, with each order's result." />
      <Panel>
        <EmptyState
          icon={<History aria-hidden className="size-5" strokeWidth={1.5} />}
          title="No batches yet"
          body="When you run an action from the desk, it appears here with what succeeded, what failed and why."
        />
      </Panel>
    </AppShell>
  );
}
