/**
 * One behavioural contract every BrokerProvider must meet (Phase 03 M5).
 * Runs against MockBroker on every `pnpm test`, and against a real Exness DEMO account through MetaApi when opted in
 * (see metaapi.contract.test.ts). Against MetaApi it also answers the open [T] questions in PROGRESS.md, so each
 * check that settles one is labelled with it.
 *
 * Safety: it places tiny real orders. It refuses to run unless the broker reports a DEMO account, tags everything it
 * opens with its own magic number, and closes all of it in afterAll even if a test fails.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrokerProvider } from "@/broker/BrokerProvider";
import { RETCODE } from "@/broker/retcodes";
import { fromPoints, roundToTickPoints, specProblems, toPoints } from "@/domain/price";
import type { Position, SymbolSpec } from "@/domain/types";

export interface ContractTarget {
  readonly broker: BrokerProvider;
  readonly symbol: string;
  /** Real brokers need a moment for the stream to reflect a trade. */
  readonly settle: () => Promise<void>;
}

/** A magic number nothing else uses, so cleanup can never touch the owner's own trades. */
const CONTRACT_MAGIC = 9_007_000_000_001;

/** Observations from a real run, printed at the end so they can be pasted into docs/09-PERFORMANCE.md. */
const observed: string[] = [];
function record(what: string, code: number, stringCode: string): void {
  observed.push(`${what}: ${String(code)} ${stringCode}`);
}

export function brokerContract(
  name: string,
  setup: () => Promise<ContractTarget>,
  opts: { timeoutMs?: number } = {},
) {
  const timeout = opts.timeoutMs ?? 5_000;

  describe(`BrokerProvider contract: ${name}`, () => {
    let target: ContractTarget | undefined;
    let spec: SymbolSpec;

    /** The target, or a clear failure if setup didn't complete. */
    const tgt = (): ContractTarget => {
      if (target === undefined) throw new Error("contract setup did not complete");
      return target;
    };

    const ours = async (): Promise<Position[]> =>
      (await tgt().broker.getPositions()).filter(
        (p) => p.symbol === tgt().symbol && p.magic === CONTRACT_MAGIC,
      );

    /** A price `pts` points away from `from`, on the tick grid. */
    const away = (from: number, pts: number) =>
      fromPoints(roundToTickPoints(from + pts * spec.point, spec), spec);

    /** Comfortably outside stops + freeze, but close enough to be realistic. */
    const gap = () => Math.max(500, (spec.stopsLevel + spec.freezeLevel) * 3 + 50);

    beforeAll(async () => {
      target = await setup();
      const account = await target.broker.getAccount();
      if (account.tradeMode !== "DEMO") {
        throw new Error(`Contract suite refuses to trade: account is ${account.tradeMode}, not DEMO.`);
      }
      spec = await target.broker.getSymbolSpec(target.symbol);
    }, 180_000);

    afterAll(async () => {
      if (observed.length > 0 && name !== "MockBroker") {
        // Facts for the [T] list. Not a secret: codes only.
        process.stdout.write(`\n[contract ${name}] observed codes:\n  ${observed.join("\n  ")}\n`);
      }
      if (target === undefined) return;
      const t = target;
      for (const p of await ours().catch(() => [])) await t.broker.closePosition(p.id);
      const orders = await t.broker.getOrders().catch(() => []);
      for (const o of orders.filter((x) => x.magic === CONTRACT_MAGIC)) await t.broker.cancelOrder(o.id);
    }, 120_000);

    it("is connected and synchronized", async () => {
      const t = tgt();
      expect(await t.broker.health()).toEqual({
        connected: true,
        connectedToBroker: true,
        synchronized: true,
      });
    });

    it("R2.9 / R2.11 can only be checked on a symbol with non-zero stops/freeze levels", async () => {
      const t = tgt();
      const s = await t.broker.getSymbolSpec(t.symbol);
      if (s.stopsLevel === 0 && s.freezeLevel === 0 && name !== "MockBroker") {
        process.stdout.write(
          `\n[contract ${name}] ${t.symbol} has stopsLevel = freezeLevel = 0: R2.9/R2.11 not exercised. Set CONTRACT_SYMBOL to one with levels.\n`,
        );
      }
      expect(s.stopsLevel).toBeGreaterThanOrEqual(0);
    });

    it("R0.2: reports a known margin mode (HEDGING needed for batches)", async () => {
      const t = tgt();
      expect(["HEDGING", "NETTING", "EXCHANGE"]).toContain((await t.broker.getAccount()).marginMode);
    });

    it("spec is usable (R0.1) and the quote is sane", async () => {
      const t = tgt();
      expect(specProblems(spec)).toEqual([]);
      const q = await t.broker.getQuote(t.symbol);
      expect(q.symbol).toBe(t.symbol);
      expect(q.bid).toBeGreaterThan(0);
      expect(q.ask).toBeGreaterThanOrEqual(q.bid);
    });

    it("R9.2: the quote carries a usable lossTickValue (the price feed has it, the spec doesn't)", async () => {
      const t = tgt();
      const q = await t.broker.getQuote(t.symbol);
      expect(q.lossTickValue).toBeGreaterThan(0);
      expect(Number.isFinite(q.lossTickValue)).toBe(true);
    });

    it("R9.3: calculateMargin returns a positive number that grows with volume (or undefined, never a guess)", async () => {
      const t = tgt();
      const q = await t.broker.getQuote(t.symbol);
      const one = await t.broker.calculateMargin({
        symbol: t.symbol,
        side: "BUY",
        volume: 0.1,
        price: q.ask,
      });
      const ten = await t.broker.calculateMargin({ symbol: t.symbol, side: "BUY", volume: 1, price: q.ask });
      if (one === undefined || ten === undefined) return; // "can't compute" is a valid answer: callers block
      expect(one).toBeGreaterThan(0);
      expect(ten).toBeGreaterThan(one);
    });

    it(
      "full position lifecycle: entry with stop + tag, preserve, no-op, invalid stops, close, close again",
      async () => {
        const t = tgt();
        const q = await t.broker.getQuote(t.symbol);
        const sl = away(q.bid, -gap());
        const entry = await t.broker.placeMarket({
          symbol: t.symbol,
          side: "BUY",
          volume: spec.volumeMin,
          sl,
          tp: null,
          magic: CONTRACT_MAGIC,
          comment: "OD:contract",
          clientId: "ct0001",
        });
        expect(entry).toMatchObject({ ok: true, class: "success" });
        expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
        await t.settle();

        // [T] magic is accepted on entry and returned on the position (R9.1).
        const [pos] = await ours();
        expect(pos).toBeDefined();
        const id = pos!.id;
        expect(pos!.magic).toBe(CONTRACT_MAGIC);
        // [T] clientId round-trips (R6.5 reconciliation depends on it), and reconcile finds it through the interface.
        expect(pos!.clientId).toBe("ct0001");
        expect((await t.broker.reconcile(["ct0001", "ct-none"])).get("ct0001")).toEqual({
          status: "position",
          positionIds: [id],
        });
        expect((await t.broker.reconcile(["ct-none"])).get("ct-none")).toEqual({ status: "notFound" });
        expect(toPoints(pos!.sl!, spec)).toBe(toPoints(sl, spec));
        expect(pos!.tp).toBeNull();

        // Set a TP while keeping the SL (both levels sent, ADR-0008).
        const tp = away(q.bid, gap());
        expect((await t.broker.modifyPosition(id, { sl, tp })).ok).toBe(true);
        await t.settle();

        // [T] R2.7: move only the SL, sending the current TP back: TP must survive.
        const sl2 = away(q.bid, -gap() - 50);
        expect((await t.broker.modifyPosition(id, { sl: sl2, tp })).ok).toBe(true);
        await t.settle();
        const after = (await ours()).find((p) => p.id === id);
        expect(toPoints(after!.sl!, spec)).toBe(toPoints(sl2, spec));
        expect(toPoints(after!.tp!, spec)).toBe(toPoints(tp, spec));

        // R2.8: sending the same levels again is a success (NO_CHANGES or DONE), never an error.
        expect((await t.broker.modifyPosition(id, { sl: sl2, tp })).ok).toBe(true);

        // [T] ADR-0008 rests on this: sending 0 for a level REMOVES it.
        expect((await t.broker.modifyPosition(id, { sl: sl2, tp: null })).ok).toBe(true);
        await t.settle();
        expect((await ours()).find((p) => p.id === id)?.tp).toBeNull();
        expect((await t.broker.modifyPosition(id, { sl: sl2, tp })).ok).toBe(true);
        await t.settle();

        // R2.1: an SL above the bid is refused with INVALID_STOPS and changes nothing.
        const bad = await t.broker.modifyPosition(id, { sl: away(q.bid, gap()), tp });
        expect(bad).toMatchObject({ ok: false, class: "final", code: RETCODE.INVALID_STOPS });

        // R4.5 [T]: close, then close again → the second is "already closed" = success.
        expect((await t.broker.closePosition(id)).ok).toBe(true);
        await t.settle();
        expect(await ours()).toEqual([]);
        const again = await t.broker.closePosition(id);
        expect(again.ok).toBe(true);
        // [T] Record what the broker really returns for a second close (the mock says 10036).
        record("close twice", again.code, again.stringCode);
      },
      timeout,
    );

    it(
      "pending order lifecycle: place far from price, appears tagged, cancel, cancel again fails",
      async () => {
        const t = tgt();
        const q = await t.broker.getQuote(t.symbol);
        const placed = await t.broker.placePending({
          symbol: t.symbol,
          type: "BUY_LIMIT",
          volume: spec.volumeMin,
          openPrice: away(q.ask, -gap() * 4),
          sl: null,
          tp: null,
          magic: CONTRACT_MAGIC,
          comment: "OD:contract",
          clientId: "ct0002",
        });
        expect(placed).toMatchObject({ ok: true, class: "success" });
        await t.settle();
        const order = (await t.broker.getOrders()).find((o) => o.magic === CONTRACT_MAGIC);
        expect(order).toMatchObject({ type: "BUY_LIMIT", symbol: t.symbol });
        expect((await t.broker.cancelOrder(order!.id)).ok).toBe(true);
        await t.settle();
        const twice = await t.broker.cancelOrder(order!.id);
        expect(twice.ok).toBe(false);
        // [T] The mock says 10035 INVALID_ORDER for this; record the real answer.
        record("cancel twice", twice.code, twice.stringCode);
      },
      timeout,
    );

    it(
      "R5.3: an entry with an invalid stop is refused, and nothing opens",
      async () => {
        const t = tgt();
        const q = await t.broker.getQuote(t.symbol);
        const r = await t.broker.placeMarket({
          symbol: t.symbol,
          side: "SELL",
          volume: spec.volumeMin,
          sl: away(q.ask, -gap()), // a SELL's SL below price: invalid
          tp: null,
          magic: CONTRACT_MAGIC,
          comment: "OD:contract",
          clientId: "ct0003",
        });
        expect(r).toMatchObject({ ok: false, class: "final" });
        record("entry with invalid stop", r.code, r.stringCode);
        await t.settle();
        expect(await ours()).toEqual([]);
      },
      timeout,
    );
  });
}
