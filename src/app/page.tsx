import { getEnv } from "@/server/env";
import { requireSession } from "@/server/http/pageSession";
import { ToastProvider } from "@/ui/Toast";
import { Desk } from "./desk/Desk";

// Mode and session come from the runtime, so this page must never be prerendered at build time.
export const dynamic = "force-dynamic";

/** The desk: live positions for one symbol, the four action tabs, and Close All Now in the thumb zone. */
export default async function HomePage() {
  await requireSession();
  const env = getEnv();
  // Mock mode's book has gold and EURUSD; other modes learn their symbols from the account's positions.
  const symbols = env.TRADING_MODE === "mock" ? ["XAUUSD", "EURUSD"] : ["XAUUSD"];
  return (
    <ToastProvider>
      <Desk mode={env.TRADING_MODE} symbols={symbols} initialSymbol={symbols[0] ?? "XAUUSD"} />
    </ToastProvider>
  );
}
