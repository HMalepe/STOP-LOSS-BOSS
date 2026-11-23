import { getEnv } from "@/server/env";
import { SystemSheet } from "./SystemSheet";

export const dynamic = "force-dynamic";

/** Design-system review sheet (docs/12-DESIGN-SYSTEM.md). Sample data only; nothing here touches the broker. */
export default function SystemPage() {
  return <SystemSheet mode={getEnv().TRADING_MODE} />;
}
