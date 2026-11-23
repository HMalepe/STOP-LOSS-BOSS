"use client";
import { Crosshair } from "lucide-react";
import { useState } from "react";
import { Panel } from "@/ui/AppShell";
import { ArmButton } from "@/ui/ArmButton";
import { Button } from "@/ui/Button";
import { ConfirmSheet } from "@/ui/ConfirmSheet";
import { planSentence } from "@/ui/logic";
import type { Mode } from "@/ui/ModeBadge";
import { PriceInput } from "@/ui/PriceInput";
import { ProgressView, type ItemView } from "@/ui/ProgressView";
import { useToast } from "@/ui/Toast";

/** Sample-only playground for the trading controls. Nothing here calls the API. */
export function ControlsDemo({ mode }: { readonly mode: Mode }) {
  const toast = useToast();
  const [price, setPrice] = useState("2660.00");
  const [sheet, setSheet] = useState<null | { expiresAt: string }>(null);
  const [sheetMode, setSheetMode] = useState<Mode>(mode);
  const summary = {
    action: "closeAt" as const,
    symbol: "XAUUSD",
    count: 5,
    breakdown: { buys: 3, sells: 2, asTP: 3, asSL: 2 },
  };
  const items: ItemView[] = [
    {
      index: 0,
      targetId: "50214",
      op: "modify",
      outcome: "failed",
      message: "Invalid stops (10016): SL too close to price",
      attempts: 1,
      latencyMs: 142,
    },
    { index: 1, targetId: "50213", op: "modify", outcome: "done", message: "", attempts: 1, latencyMs: 118 },
    { index: 2, targetId: "50215", op: "modify", outcome: "done", message: "", attempts: 2, latencyMs: 301 },
    {
      index: 3,
      targetId: "50216",
      op: "modify",
      outcome: "unknown",
      message: "Timed out; may have been applied. Check MT5.",
      attempts: 1,
      latencyMs: 9000,
    },
  ];
  return (
    <>
      <Panel title="Controls" meta="sample · nothing is sent">
        <div className="flex flex-col gap-5">
          <PriceInput
            label="Close at"
            value={price}
            onChange={setPrice}
            digits={2}
            bid={2650.1}
            ask={2650.3}
            hint="20 pt spread"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="primary"
              icon={<Crosshair aria-hidden className="size-4" />}
              onClick={() => {
                setSheetMode(mode);
                setSheet({ expiresAt: new Date(Date.now() + 30_000).toISOString() });
              }}
            >
              Preview
            </Button>
            <Button
              onClick={() => {
                setSheetMode("live");
                setSheet({ expiresAt: new Date(Date.now() + 30_000).toISOString() });
              }}
            >
              Preview as LIVE
            </Button>
          </div>
          <ArmButton
            label="Close all now"
            armedLabel="Tap again to close 5"
            onFire={() => {
              toast("Sample: would close 5 positions now.", "ok");
            }}
          />
        </div>
      </Panel>

      <ProgressView
        progress={{ total: 5, done: 4, ok: 2, failed: 1, unknown: 1, skipped: 0 }}
        finished
        items={items}
        onRetry={() => {
          toast("Sample: would preview the 1 that failed.");
        }}
        onDone={() => {
          toast("Sample: back to the desk.");
        }}
      />

      {sheet === null ? null : (
        <ConfirmSheet
          mode={sheetMode}
          confirmLabel="Confirm"
          plan={{
            sentence: planSentence(summary, { action: "closeAt", price }),
            expiresAt: sheet.expiresAt,
            count: 5,
            breakdown: [
              { label: "Positions", value: "5" },
              { label: "As take profit", value: "3", tone: "up" },
              { label: "As stop loss", value: "2", tone: "down" },
            ],
            warnings: [
              "Buys close on the bid and sells on the ask, so they won't trigger at the same instant.",
            ],
            skipped: [{ id: "50217", reason: "too close to price for its side" }],
          }}
          onCancel={() => {
            setSheet(null);
          }}
          onExpire={() => {
            setSheet(null);
            toast("Preview expired. Nothing was sent.");
          }}
          onConfirm={() => {
            setSheet(null);
            toast("Sample: confirmed. Nothing was sent.", "ok");
          }}
        />
      )}
    </>
  );
}
