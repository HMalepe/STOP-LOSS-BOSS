/** Runs once when the server boots. Bad config stops the server from starting (docs/05-SECURITY.md: fail fast). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootOrExit, installShutdown, nodeSignalIo } = await import("./server/boot");
    bootOrExit();
    const { getEnv } = await import("./server/env");
    const env = getEnv();
    // Without NEXT_MANUAL_SIG_HANDLE, Next.js exits on SIGTERM before any drain could run (the env check requires it
    // outside mock mode). Mock/dev keeps Next's default.
    if (env.NEXT_MANUAL_SIG_HANDLE === "true") {
      const { shutdownTradingServices } = await import("./server/trading/services");
      installShutdown(
        () => shutdownTradingServices({ drainMs: env.SHUTDOWN_DRAIN_MS }),
        env.SHUTDOWN_DRAIN_MS,
        nodeSignalIo(),
      );
    }
  }
}
