/**
 * The screenshot set for design review (docs/screens/phone). Off by default; run: SCREENS=1 pnpm test:e2e screens
 * Every screen and important state, in the order the owner meets them.
 */
import { expect, test, type Page } from "@playwright/test";
import { signInWithRecovery } from "./helpers";

test.skip(process.env.SCREENS !== "1", "set SCREENS=1 to re-shoot docs/screens");
test.describe.configure({ mode: "serial" });

const DIR = "docs/screens/phone";
const shot = (page: Page, name: string, full = false) =>
  page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });

test("every screen", async ({ page, context }) => {
  await page.goto("/login");
  await shot(page, "01-sign-in");
  await page.getByLabel("Password").fill("wrong wrong wrong");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Wrong password" })).toBeVisible();
  await shot(page, "02-sign-in-error");

  await signInWithRecovery(page, 9);
  await expect(page.getByText("5 open · 1 pending")).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "03-desk");
  await shot(page, "04-desk-full", true);

  await page.getByRole("tab", { name: "SL/TP" }).click();
  await page.getByRole("tab", { name: "Buys" }).click();
  await page.getByLabel("Take profit").fill("2700.00");
  await shot(page, "05-sltp-tab");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, "06-confirm-sheet");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Confirm/ })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "All 3 done" })).toBeVisible();
  await page.waitForTimeout(600); // smooth scroll to the result
  await shot(page, "07-progress-done");
  await page.getByRole("button", { name: "Done", exact: true }).click();

  await page.getByRole("tab", { name: "Sells" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.waitForTimeout(600); // smooth scroll to the reason
  await shot(page, "08-plan-invalid");

  await page.getByRole("tab", { name: "Helpers" }).click();
  await page.waitForTimeout(300);
  await shot(page, "09-helpers-tab");
  await page.getByRole("tab", { name: "Orders" }).click();
  await shot(page, "10-orders-tab");

  await page.getByRole("button", { name: "Close all now" }).click();
  await page.waitForTimeout(400); // let the arm transition finish (a mid-transition frame looks disabled)
  await shot(page, "11-close-armed");
  await page.getByRole("button", { name: /Tap again: close all/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /All \d+ done/ })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Nothing open on XAUUSD").first()).toBeVisible();
  await shot(page, "12-desk-empty");

  await page.goto("/history");
  await expect(page.getByText("All done").first()).toBeVisible();
  await shot(page, "13-history");
  await page.goto("/settings");
  await expect(page.getByText("trading is on")).toBeVisible();
  await shot(page, "14-settings", true);
  await page.getByRole("button", { name: "Halt trading now" }).click();
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "Trading halted." })).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, "15-desk-halted");
  await page.goto("/settings");
  await page.getByRole("button", { name: "Resume trading" }).click();

  await context.setOffline(true);
  await page.waitForTimeout(300);
  await page.goto("/").catch(() => undefined);
  await shot(page, "16-offline");
  await context.setOffline(false);
});
