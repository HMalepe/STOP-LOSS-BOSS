/**
 * Node-only boot: validate the env or exit. Loaded from src/instrumentation.ts behind a runtime check
 * so the Edge bundle never sees process.exit.
 *
 * Next.js would otherwise keep a misconfigured process alive and answer 500s. On an always-on host
 * (ADR-0007) that looks half-healthy and never restarts, so we exit with code 1 instead.
 */
import { EnvError, getEnv } from "./env";
import { getLogger } from "./logger";

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
