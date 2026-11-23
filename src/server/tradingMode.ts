/**
 * Which account may this app trade on? (docs/05, CLAUDE.md non-negotiable 2.)
 * - mock: the mock broker only.
 * - demo: the broker must report a DEMO (or CONTEST) account. A REAL account under a "demo" app is refused: a mislabelled
 *   account is exactly how real money gets traded by accident.
 * - live: TRADING_MODE=live AND accounts.live_enabled AND the broker reports REAL. Any one missing → refused.
 */
import type { AccountTradeMode } from "@/broker/BrokerProvider";
import type { TradingMode } from "./env";

export type ModeGate =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "LIVE_NOT_ENABLED" | "ACCOUNT_MODE_MISMATCH";
      readonly message: string;
    };

export function tradingModeGate(input: {
  readonly mode: TradingMode;
  readonly liveEnabled: boolean;
  /** What the broker says the account is (null in mock mode). */
  readonly brokerTradeMode: AccountTradeMode | null;
}): ModeGate {
  switch (input.mode) {
    case "mock":
      return input.brokerTradeMode === null
        ? { ok: true }
        : {
            ok: false,
            code: "ACCOUNT_MODE_MISMATCH",
            message: "Mock mode must not be connected to a real broker account.",
          };
    case "demo":
      return input.brokerTradeMode === "DEMO" || input.brokerTradeMode === "CONTEST"
        ? { ok: true }
        : {
            ok: false,
            code: "ACCOUNT_MODE_MISMATCH",
            message: `The app is in DEMO mode but the broker account is ${input.brokerTradeMode ?? "unknown"}. Refusing to trade.`,
          };
    case "live":
      if (!input.liveEnabled) {
        return {
          ok: false,
          code: "LIVE_NOT_ENABLED",
          message: "Live trading isn't enabled for this account (needs re-auth to turn on).",
        };
      }
      return input.brokerTradeMode === "REAL"
        ? { ok: true }
        : {
            ok: false,
            code: "ACCOUNT_MODE_MISMATCH",
            message: `The app is in LIVE mode but the broker account is ${input.brokerTradeMode ?? "unknown"}. Refusing to trade.`,
          };
  }
}
