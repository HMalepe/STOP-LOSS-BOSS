import { expect, test } from "@playwright/test";
import { signInWithRecovery } from "./helpers";

test.describe.configure({ mode: "serial" });

test("the desk: live book, SL/TP preview → confirm → progress → done, then Close All Now", async ({
  page,
}) => {
  await signInWithRecovery(page, 0);

  // Live data from /api/state + /api/positions (mock broker's seeded book: 5 XAUUSD positions, 1 pending order).
  await expect(page.getByRole("combobox", { name: "Symbol" })).toHaveValue("XAUUSD");
  await expect(page.getByText("5 open · 1 pending")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveCount(1);

  // Buys only, TP 2700.00 → preview → the sheet in plain words.
  await page.getByRole("tab", { name: "Buys" }).click();
  await page.getByRole("tab", { name: "SL/TP" }).click();
  await page.getByLabel("Take profit").fill("2700.00");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("3 XAUUSD positions get TP 2700.00. Existing SLs stay.");
  await expect(sheet.getByRole("timer")).toBeVisible();

  await sheet.getByRole("button", { name: "Confirm 3" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All 3 done" })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // Invalid for sells → 422 explained, nothing sent.
  await page.getByRole("tab", { name: "Sells" }).click();
  await page.getByLabel("Take profit").fill("2700.00");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("alert").first()).toContainText(/sell/i);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Close All Now: arm, then fire.
  await page.getByRole("button", { name: "Close all now" }).click();
  await page.getByRole("button", { name: "Tap again to close 5" }).click();
  await expect(page.getByRole("status").filter({ hasText: /All 6 done/ })).toBeVisible();
  await expect(page.getByText("Nothing open on XAUUSD").first()).toBeVisible();
});
