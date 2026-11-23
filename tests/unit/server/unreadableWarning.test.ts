import { describe, expect, it } from "vitest";
import { unreadableWarning } from "@/server/trading/manage";

const row = (id: string | null, symbol: string | null = "XAUUSD") => ({ id, symbol, reason: "bad" });

describe("close-now: rows it couldn't read are never silent", () => {
  it("nothing on this symbol → no warning (other symbols aren't part of this close)", () => {
    expect(unreadableWarning("position", [row("1", "EURUSD")], "XAUUSD")).toEqual([]);
    expect(unreadableWarning("position", [], "XAUUSD")).toEqual([]);
  });

  it("one ticket; symbol match ignores case", () => {
    expect(unreadableWarning("position", [row("9", "xauusd")], "XAUUSD")).toEqual([
      "1 position couldn't be read (ticket 9): it is NOT closed. Close it in MT5.",
    ]);
  });

  it("many tickets are capped at five, plus rows with no ticket or no symbol", () => {
    const rows = ["1", "2", "3", "4", "5", "6", "7"].map((t) => row(t)).concat([row(null), row(null, null)]);
    expect(unreadableWarning("position", rows, "XAUUSD")).toEqual([
      "9 positions couldn't be read (tickets 1, 2, 3, 4, 5 and 2 more, 2 with no ticket): they are NOT closed. Close them in MT5.",
    ]);
  });

  it("pending orders say cancelled", () => {
    expect(unreadableWarning("pending order", [row(null)], "XAUUSD")).toEqual([
      "1 pending order couldn't be read (one with no ticket): it is NOT cancelled. Cancel it in MT5.",
    ]);
  });
});
