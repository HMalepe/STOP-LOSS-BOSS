/**
 * Node-only boot: validate the env or exit. Loaded from src/instrumentation.ts behind a runtime check
 * so the Edge bundle never sees process.exit.
 *
 * Next.js would otherwise keep a misconfigured process alive and answer 500s. On an always-on host
 * (ADR-0007) that looks half-healthy and never restarts, so we exit with code 1 instead.
 */
import { EnvError, getEnv } from "./env";
import { getLogger } from "./logger";
import type { ShutdownReport } from "./shutdown";

export interface BootIo {
  readonly writeError: (text: string) => void;
  readonly exit: (code: number) => never;
}

const nodeIo: BootIo = {
  writeError: (text) => process.stderr.write(text),
  exit: (code) => process.exit(code),
};

export function bootOrExit(io: BootIo = nodeIo): void {
  let env;
  try {
    env = getEnv();
  } catch (e) {
    if (!(e instanceof EnvError)) throw e;
    // EnvError messages name variables, never values, so this is safe to print.
    io.writeError(`${e.message}\n`);
    io.exit(1);
  }
  getLogger().info({ mode: env.TRADING_MODE, halted: env.TRADING_HALTED }, "order-desk booted");
}

export interface SignalIo {
  readonly on: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
  readonly exit: (code: number) => void;
  /** Must not keep the process alive on its own. */
  readonly setTimer: (ms: number, fn: () => void) => void;
  readonly log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
}

/** Backstop on top of the drain: closes are bounded too, so this only fires on a bug. */
const BACKSTOP_EXTRA_MS = 10_000;

/**
 * SIGTERM/SIGINT → drain and close, then exit. A second signal (an impatient operator, or the host escalating) exits at
 * once: anything cut off is resolved by boot recovery on the next start. Exit code 1 whenever something didn't finish
 * cleanly, so the host's logs show it.
 */
export function installShutdown(run: () => Promise<ShutdownReport>, drainMs: number, io: SignalIo): void {
  let started = false;
  const handler = () => {
    if (started) {
      io.log.warn({}, "second signal during shutdown: exiting now");
      io.exit(1);
      return;
    }
    started = true;
    io.log.info({ drainMs }, "shutdown: draining");
    io.setTimer(drainMs + BACKSTOP_EXTRA_MS, () => {
      io.log.error({}, "shutdown: backstop timer fired, exiting");
      io.exit(1);
    });
    run().then(
      (report) => {
        const clean = report.drained && report.errors.length === 0;
        if (clean) io.log.info({ report }, "shutdown: clean");
        else io.log.warn({ report }, "shutdown: did not drain cleanly");
        io.exit(clean ? 0 : 1);
      },
      (e: unknown) => {
        io.log.error({ err: e instanceof Error ? e.message : String(e) }, "shutdown failed");
        io.exit(1);
      },
    );
  };
  io.on("SIGTERM", handler);
  io.on("SIGINT", handler);
}

/** Real process wiring. Only when Next.js leaves signals to us (NEXT_MANUAL_SIG_HANDLE), else it exits first anyway. */
export function nodeSignalIo(): SignalIo {
  const log = getLogger();
  return {
    on: (signal, handler) => process.on(signal, handler),
    exit: (code) => process.exit(code),
    setTimer: (ms, fn) => setTimeout(fn, ms).unref(),
    log: {
      info: (o, m) => {
        log.info(o, m);
      },
      warn: (o, m) => {
        log.warn(o, m);
      },
      error: (o, m) => {
        log.error(o, m);
      },
    },
  };
}
