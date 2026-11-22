/**
 * The only file that touches the real MetaApi SDK. Needs network and an account, so it's exercised by the contract
 * tests when demo credentials are set, not by unit tests (excluded from unit coverage in vitest.config.ts).
 *
 * Loaded with require(): the package's "import" condition points at its browser build.
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

export async function openMetaApiConnection(cfg: MetaApiConfig): Promise<MetaApiConnectionPort> {
  const require = createRequire(import.meta.url);
  const sdk = require("metaapi.cloud-sdk") as SdkModule;
  const api = new sdk.default(cfg.token, {
    region: cfg.region,
    // The SDK only retries reads; our executor owns trade retries (ADR-0008).
    requestTimeout: 60,
    retryOpts: { retries: 3, minDelayInSeconds: 1, maxDelayInSeconds: 10 },
  });
  const account = await api.metatraderAccountApi.getAccount(cfg.accountId);
  const connection = account.getStreamingConnection();
  await connection.connect();
  await connection.waitSynchronized({ timeoutInSeconds: cfg.syncTimeoutSec ?? 120 });
  return connection as unknown as MetaApiConnectionPort;
}
