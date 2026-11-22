/** One MetaApi connection per process (Phase 03 M4). A failed connect clears the cache so the next call retries. */
import { MetaApiBroker, type ConnectOptions, type MetaApiBrokerOptions } from "./MetaApiBroker";
import type { MetaApiConnectionPort } from "./port";

let shared: Promise<MetaApiBroker> | undefined;

export function sharedMetaApiBroker(
  factory: () => Promise<MetaApiConnectionPort>,
  opts: MetaApiBrokerOptions & ConnectOptions = {},
): Promise<MetaApiBroker> {
  shared ??= MetaApiBroker.connect(factory, opts).catch((e: unknown) => {
    shared = undefined;
    throw e;
  });
  return shared;
}

/** Tests only: forget the shared connection. */
export function resetSharedMetaApiBroker(): void {
  shared = undefined;
}

export { MetaApiBroker } from "./MetaApiBroker";
export type { MetaApiConnectionPort } from "./port";
