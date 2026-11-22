/**
 * One MetaApi connection per process (Phase 03 M4), kept healthy by a watchdog.
 * - Cached on globalThis so dev hot-reload doesn't open a second connection.
 * - A failed connect is forgotten, so the next call retries.
 * - The watchdog drops a connection that has been unhealthy for `unhealthyForMs` (dead stream, undeployed account,
 *   expired token) and clears the cache: the next caller reconnects with backoff. The SDK heals short blips itself.
 */
import { MetaApiBroker, type ConnectOptions, type MetaApiBrokerOptions } from "./MetaApiBroker";
import type { MetaApiConnectionPort } from "./port";

export interface WatchdogOptions {
  readonly intervalMs?: number;
  readonly unhealthyForMs?: number;
  readonly now?: () => number;
  /** Called when the watchdog drops the connection (wire to logs/metrics). */
  readonly onDrop?: (reason: string) => void;
}

interface SharedState {
  promise?: Promise<MetaApiBroker> | undefined;
  timer?: ReturnType<typeof setInterval> | undefined;
}

const KEY = "__orderDeskMetaApi";
const g = globalThis as typeof globalThis & { [KEY]?: SharedState };
const state: SharedState = (g[KEY] ??= {});

function stopWatchdog(): void {
  if (state.timer !== undefined) clearInterval(state.timer);
  state.timer = undefined;
}

function startWatchdog(broker: MetaApiBroker, promise: Promise<MetaApiBroker>, opts: WatchdogOptions): void {
  const now = opts.now ?? (() => Date.now());
  const limit = opts.unhealthyForMs ?? 60_000;
  let badSince: number | null = null;
  stopWatchdog();
  state.timer = setInterval(() => {
    void broker.health().then(async (h) => {
      if (state.promise !== promise) return; // superseded
      if (h.connected && h.connectedToBroker && h.synchronized) {
        badSince = null;
        return;
      }
      badSince ??= now();
      if (now() - badSince < limit) return;
      stopWatchdog();
      state.promise = undefined;
      opts.onDrop?.(`unhealthy for ${String(limit)} ms: ${JSON.stringify(h)}`);
      await broker.close().catch(() => undefined);
    });
  }, opts.intervalMs ?? 5_000);
  // Never keep the process alive just for the watchdog.
  (state.timer as { unref?: () => void }).unref?.();
}

export function sharedMetaApiBroker(
  factory: () => Promise<MetaApiConnectionPort>,
  opts: MetaApiBrokerOptions & ConnectOptions & { readonly watchdog?: WatchdogOptions | false } = {},
): Promise<MetaApiBroker> {
  if (state.promise === undefined) {
    const promise: Promise<MetaApiBroker> = MetaApiBroker.connect(factory, opts).then(
      (broker) => {
        if (opts.watchdog !== false) startWatchdog(broker, promise, opts.watchdog ?? {});
        return broker;
      },
      (e: unknown) => {
        if (state.promise === promise) state.promise = undefined;
        throw e;
      },
    );
    state.promise = promise;
  }
  return state.promise;
}

/** Graceful shutdown: stop the watchdog and close the shared connection, if any. */
export async function closeSharedMetaApiBroker(): Promise<void> {
  const p = state.promise;
  stopWatchdog();
  state.promise = undefined;
  if (p !== undefined) await p.then((b) => b.close()).catch(() => undefined);
}

/** Tests only: forget the shared connection without closing it. */
export function resetSharedMetaApiBroker(): void {
  stopWatchdog();
  state.promise = undefined;
}

export { MetaApiBroker } from "./MetaApiBroker";
export type { MetaApiConnectionPort } from "./port";
