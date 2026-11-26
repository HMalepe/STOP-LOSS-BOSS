/**
 * The only file that touches the real MetaApi SDK. Needs network and an account, so it's exercised by the contract
 * tests when demo credentials are set, not by unit tests (excluded from unit coverage in vitest.config.ts).
 *
 * - Loaded with require(): the package's "import" condition points at its browser build.
 * - The port is an explicit object over the SDK's typed methods, with NO cast: if an SDK upgrade changes a signature,
 *   this file stops compiling instead of failing at runtime. (Board review: a cast here once hid a real mismatch.)
 * - Every path that fails or closes also closes the MetaApi client, so retries never leak websockets.
 */
import { createRequire } from "node:module";
import type * as Sdk from "metaapi.cloud-sdk";
import type { MetaApiConnectionPort } from "./port";

export interface MetaApiConfig {
  readonly token: string;
  readonly accountId: string;
  readonly region: string;
  /** Seconds to wait for the terminal state to synchronize. */
  readonly syncTimeoutSec?: number;
}

type SdkModule = typeof Sdk;
type Api = InstanceType<SdkModule["default"]>;
type Account = Awaited<ReturnType<Api["metatraderAccountApi"]["getAccount"]>>;
type Streaming = ReturnType<Account["getStreamingConnection"]>;

export async function openMetaApiConnection(cfg: MetaApiConfig): Promise<MetaApiConnectionPort> {
  const require = createRequire(import.meta.url);
  const sdk = require("metaapi.cloud-sdk") as SdkModule;
  const api: Api = new sdk.default(cfg.token, {
    region: cfg.region,
    // The SDK only retries reads; our executor owns trade retries (ADR-0008).
    requestTimeout: 30,
    retryOpts: { retries: 2, minDelayInSeconds: 1, maxDelayInSeconds: 5 },
  });
  let conn: Streaming | undefined;
  try {
    const account = await api.metatraderAccountApi.getAccount(cfg.accountId);
    conn = account.getStreamingConnection();
    await conn.connect();
    await conn.waitSynchronized({ timeoutInSeconds: cfg.syncTimeoutSec ?? 90 });
  } catch (e) {
    await conn?.close().catch(() => undefined);
    api.close();
    throw e;
  }
  return toPort(conn, api);
}

function toPort(c: Streaming, api: Api): MetaApiConnectionPort {
  return {
    get terminalState() {
      return c.terminalState;
    },
    get synchronized() {
      return c.synchronized;
    },
    subscribeToMarketData: (symbol) => c.subscribeToMarketData(symbol, [{ type: "quotes" }]),
    calculateMargin: (order) => c.calculateMargin(order),
    modifyPosition: (id, sl, tp) => c.modifyPosition(id, sl, tp),
    closePosition: (id) => c.closePosition(id, {}),
    cancelOrder: (id) => c.cancelOrder(id),
    createMarketBuyOrder: (s, v, sl, tp, o) => c.createMarketBuyOrder(s, v, sl, tp, o),
    createMarketSellOrder: (s, v, sl, tp, o) => c.createMarketSellOrder(s, v, sl, tp, o),
    createLimitBuyOrder: (s, v, p, sl, tp, o) => c.createLimitBuyOrder(s, v, p, sl, tp, o),
    createLimitSellOrder: (s, v, p, sl, tp, o) => c.createLimitSellOrder(s, v, p, sl, tp, o),
    createStopBuyOrder: (s, v, p, sl, tp, o) => c.createStopBuyOrder(s, v, p, sl, tp, o),
    createStopSellOrder: (s, v, p, sl, tp, o) => c.createStopSellOrder(s, v, p, sl, tp, o),
    close: async () => {
      await c.close().catch(() => undefined);
      api.close();
    },
  };
}
