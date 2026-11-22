/**
 * The same contract against a real Exness DEMO account through MetaApi. Off by default.
 * Run with: CONTRACT_METAAPI=1 METAAPI_TOKEN=… METAAPI_ACCOUNT_ID=… METAAPI_REGION=… pnpm test:contract
 * Optional: CONTRACT_SYMBOL (default EURUSD). The suite refuses to run on anything but a DEMO account.
 */
import { describe, it } from "vitest";
import { MetaApiBroker } from "@/broker/metaapi";
import { openMetaApiConnection } from "@/broker/metaapi/sdk";
import { brokerContract } from "./brokerContract";

const env = process.env;
const enabled =
  env.CONTRACT_METAAPI === "1" &&
  [env.METAAPI_TOKEN, env.METAAPI_ACCOUNT_ID, env.METAAPI_REGION].every((v) => v !== undefined && v !== "");

if (enabled) {
  brokerContract(
    "MetaApiBroker (Exness demo)",
    async () => ({
      broker: await MetaApiBroker.connect(() =>
        openMetaApiConnection({
          token: env.METAAPI_TOKEN ?? "",
          accountId: env.METAAPI_ACCOUNT_ID ?? "",
          region: env.METAAPI_REGION ?? "",
        }),
      ),
      symbol: env.CONTRACT_SYMBOL ?? "EURUSD",
      settle: () => new Promise((r) => setTimeout(r, 1_500)),
    }),
    { timeoutMs: 60_000 },
  );
} else {
  describe("BrokerProvider contract: MetaApiBroker (Exness demo)", () => {
    it.skip("set CONTRACT_METAAPI=1 and demo credentials to run against a real account", () => undefined);
  });
}
