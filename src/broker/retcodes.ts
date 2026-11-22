/**
 * MT5 trade return codes and how we treat them (03-TRADING-RULES §6, ADR-0008).
 * Codes: https://www.mql5.com/en/docs/constants/errorswarnings/enum_trade_return_codes
 * MetaApi success set: https://metaapi.cloud/docs/client/models/metatraderTradeResponse/ (0, 10008-10010, 10025).
 */

/** The operations we send. Some codes mean different things per op (R4.5, R6.5). */
export type BrokerOp = "modify" | "close" | "cancel" | "market" | "pending";

/**
 * success   - done (or nothing to do)
 * retryable - safe to try again per §6
 * ambiguous - the request may or may not have executed: reconcile before any retry (R6.5)
 * final     - don't retry; report the reason
 */
export type TradeClass = "success" | "retryable" | "ambiguous" | "final";

export const RETCODE = {
  NO_ERROR: 0,
  REQUOTE: 10004,
  REJECT: 10006,
  CANCEL: 10007,
  PLACED: 10008,
  DONE: 10009,
  DONE_PARTIAL: 10010,
  ERROR: 10011,
  TIMEOUT: 10012,
  INVALID: 10013,
  INVALID_VOLUME: 10014,
  INVALID_PRICE: 10015,
  INVALID_STOPS: 10016,
  TRADE_DISABLED: 10017,
  MARKET_CLOSED: 10018,
  NO_MONEY: 10019,
  PRICE_CHANGED: 10020,
  PRICE_OFF: 10021,
  INVALID_EXPIRATION: 10022,
  ORDER_CHANGED: 10023,
  TOO_MANY_REQUESTS: 10024,
  NO_CHANGES: 10025,
  SERVER_DISABLES_AT: 10026,
  CLIENT_DISABLES_AT: 10027,
  LOCKED: 10028,
  FROZEN: 10029,
  INVALID_FILL: 10030,
  CONNECTION: 10031,
  ONLY_REAL: 10032,
  LIMIT_ORDERS: 10033,
  LIMIT_VOLUME: 10034,
  INVALID_ORDER: 10035,
  POSITION_CLOSED: 10036,
} as const;

export type RetcodeName = keyof typeof RETCODE;

const NAME_BY_CODE = new Map<number, RetcodeName>(
  (Object.entries(RETCODE) as [RetcodeName, number][]).map(([name, code]) => [code, name]),
);

/** Our own codes for failures that never reached MT5. Negative so they can't collide with MT5's. */
export const LOCAL_CODE = {
  /** The adapter's own timeout fired: outcome unknown. */
  ADAPTER_TIMEOUT: -1,
  /** MetaApi said 429 (TooManyRequestsError). */
  RATE_LIMITED: -2,
  /** Not connected / not synchronized: nothing was sent. */
  NOT_CONNECTED: -3,
  /** Anything else thrown by the SDK. Unknown outcome for entries. */
  UNKNOWN_ERROR: -4,
} as const;

const SUCCESS = new Set<number>([
  RETCODE.NO_ERROR,
  RETCODE.PLACED,
  RETCODE.DONE,
  RETCODE.DONE_PARTIAL,
  RETCODE.NO_CHANGES,
]);
const RETRYABLE = new Set<number>([
  RETCODE.REQUOTE,
  RETCODE.PRICE_CHANGED,
  RETCODE.PRICE_OFF,
  RETCODE.TOO_MANY_REQUESTS,
  LOCAL_CODE.RATE_LIMITED,
  LOCAL_CODE.NOT_CONNECTED,
]);
const MAYBE_EXECUTED = new Set<number>([
  RETCODE.TIMEOUT,
  RETCODE.CONNECTION,
  LOCAL_CODE.ADAPTER_TIMEOUT,
  LOCAL_CODE.UNKNOWN_ERROR,
]);

const isEntry = (op: BrokerOp) => op === "market" || op === "pending";

/** §6 classification. Unknown codes are final (R6.4). */
export function classify(code: number, op: BrokerOp): TradeClass {
  // A partial close leaves volume open: not done. Sending close by ticket again closes the rest.
  if (code === RETCODE.DONE_PARTIAL && op === "close") return "retryable";
  if (SUCCESS.has(code)) return "success";
  // R4.5: closing something already closed is the outcome we wanted.
  if (code === RETCODE.POSITION_CLOSED) return op === "close" ? "success" : "final";
  if (RETRYABLE.has(code)) return "retryable";
  if (MAYBE_EXECUTED.has(code)) {
    // R6.5: an entry may have landed. Modify/close/cancel are safe to resend (same levels = no-op; closed = 10036).
    return isEntry(op) ? "ambiguous" : "retryable";
  }
  return "final";
}

/** MetaApi sometimes reports only the string code. */
export function codeFromString(stringCode: string): number | null {
  if (stringCode === "ERR_NO_ERROR") return RETCODE.NO_ERROR;
  const name = stringCode.replace(/^TRADE_RETCODE_/, "");
  return name in RETCODE ? RETCODE[name as RetcodeName] : null;
}

export function codeName(code: number): string {
  const local = (Object.entries(LOCAL_CODE) as [string, number][]).find(([, c]) => c === code)?.[0];
  if (local !== undefined) return local;
  const name = NAME_BY_CODE.get(code);
  return name === undefined
    ? `UNKNOWN_${String(code)}`
    : name === "NO_ERROR"
      ? "ERR_NO_ERROR"
      : `TRADE_RETCODE_${name}`;
}
