/** Runs once when the server boots. Bad config stops the server from starting (docs/05-SECURITY.md: fail fast). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootOrExit } = await import("./server/boot");
    bootOrExit();
  }
}
