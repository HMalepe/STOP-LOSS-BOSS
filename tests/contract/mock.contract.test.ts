import { MockBroker } from "@/broker/MockBroker";
import { ManualClock } from "@/domain/clock";
import { brokerContract } from "./brokerContract";

brokerContract("MockBroker", () =>
  Promise.resolve({
    broker: new MockBroker({
      clock: new ManualClock(1_763_769_600_000),
      seed: 3,
      rateLimit: null,
      symbols: [
        {
          spec: {
            symbol: "EURUSD",
            digits: 5,
            point: 0.00001,
            tickSize: 0.00001,
            stopsLevel: 10,
            freezeLevel: 5,
            volumeMin: 0.01,
            volumeMax: 50,
            volumeStep: 0.01,
          },
          bid: 1.086,
          ask: 1.0861,
          tickValue: 1,
          contractSize: 100_000,
        },
      ],
    }),
    symbol: "EURUSD",
    settle: () => Promise.resolve(),
  }),
);
