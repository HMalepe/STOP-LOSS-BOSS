import { getEnv } from "@/server/env";
import { requireSession } from "@/server/http/pageSession";
import { AppShell, PageHeader } from "@/ui/AppShell";
import { HistoryList } from "./HistoryList";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  await requireSession();
  return (
    <AppShell mode={getEnv().TRADING_MODE}>
      <PageHeader title="History" subtitle="Every batch you've run, and how it really ended." />
      <HistoryList />
    </AppShell>
  );
}
