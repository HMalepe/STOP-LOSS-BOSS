/**
 * The slice of the MetaApi SDK we use (verified against metaapi.cloud-sdk@29.3.4, docs/09-PERFORMANCE.md).
 * MetaApiBroker depends on this, not on the SDK, so it can be tested with a fake and swapped if the SDK changes.
 * Raw values are `unknown`: everything is parsed with Zod (schemas.ts) before use.
 */
export interface TerminalStatePort {
  readonly connected: boolean;
  readonly connectedToBroker: boolean;
  readonly accountInformation: unknown;
  readonly positions: unknown;
  readonly orders: unknown;
  specification(symbol: string): unknown;
  price(symbol: string): unknown;
  waitForPrice(symbol: string, timeoutInSeconds?: number): Promise<unknown>;
}

export interface TradeOptionsPort {
  readonly magic: number;
  readonly comment: string;
  readonly clientId: string;
}

export interface MetaApiConnectionPort {
  readonly terminalState: TerminalStatePort;
  readonly synchronized: boolean;
  subscribeToMarketData(symbol: string): Promise<unknown>;
  /** MarginOrder: { symbol, type: ORDER_TYPE_BUY | ORDER_TYPE_SELL, volume, openPrice } → { margin?: number } */
  calculateMargin(order: {
    symbol: string;
    type: "ORDER_TYPE_BUY" | "ORDER_TYPE_SELL";
    volume: number;
    openPrice: number;
  }): Promise<unknown>;
  modifyPosition(positionId: string, stopLoss: number, takeProfit: number): Promise<unknown>;
  closePosition(positionId: string): Promise<unknown>;
  cancelOrder(orderId: string): Promise<unknown>;
  createMarketBuyOrder(
    symbol: string,
    volume: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  createMarketSellOrder(
    symbol: string,
    volume: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  createLimitBuyOrder(
    symbol: string,
    volume: number,
    openPrice: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  createLimitSellOrder(
    symbol: string,
    volume: number,
    openPrice: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  createStopBuyOrder(
    symbol: string,
    volume: number,
    openPrice: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  createStopSellOrder(
    symbol: string,
    volume: number,
    openPrice: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    options: TradeOptionsPort,
  ): Promise<unknown>;
  close(): Promise<void>;
}
