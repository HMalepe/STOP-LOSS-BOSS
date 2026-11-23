import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_RECOVERY_FILE } from "./fixtures";

/** Sign in with recovery code #n (each spec uses its own, so no two fight over one TOTP step). */
export async function signInWithRecovery(page: Page, n: number): Promise<void> {
  const codes = JSON.parse(readFileSync(E2E_RECOVERY_FILE, "utf8")) as string[];
  await page.goto("/login");
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Lost your phone? Use a recovery code" }).click();
  await page.getByLabel("Recovery code").fill(codes[n] ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}
