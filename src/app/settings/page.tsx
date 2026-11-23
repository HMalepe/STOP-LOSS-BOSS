import { Settings2 } from "lucide-react";
import { getEnv } from "@/server/env";
import { AppShell, PageHeader, Panel } from "@/ui/AppShell";
import { EmptyState } from "@/ui/States";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <AppShell mode={getEnv().TRADING_MODE}>
      <PageHeader title="Settings" subtitle="Kill switch, limits, sign-in and the account mode." />
      <Panel>
        <EmptyState
          icon={<Settings2 aria-hidden className="size-5" strokeWidth={1.5} />}
          title="Settings arrive with the desk"
          body="The kill switch, limits and recovery codes get their screens in this phase. The kill switch already works through the API."
        />
      </Panel>
    </AppShell>
  );
}
