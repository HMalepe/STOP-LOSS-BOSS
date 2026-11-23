import { expect, test, type Page } from "@playwright/test";
import { totpAt } from "@/server/auth/totp";
import { E2E_PASSWORD, E2E_TOTP_SECRET } from "./fixtures";

const code = () => totpAt(E2E_TOTP_SECRET, Date.now());

async function password(page: Page, pw: string) {
  await page.goto("/login");
  await page.getByLabel("Password").fill(pw);
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe.configure({ mode: "serial" });

test("the desk needs a session: / redirects to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await expect(page.getByRole("status", { name: /mock mode/i })).toHaveText("MOCK");
});

test("a wrong password says so, in plain words", async ({ page }) => {
  await password(page, "not the password at all");
  await expect(page.getByRole("alert").filter({ hasText: "Wrong password or code." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
});

test("password → six code boxes (typed, auto-submits) → the desk", async ({ page }) => {
  await password(page, E2E_PASSWORD);
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await expect(page.getByLabel("Digit 1")).toBeFocused();
  await page.keyboard.type(code());
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Order Desk", level: 1 })).toBeVisible();
  // Signed in: /login sends you back to the desk.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/$/);
});

test("a pasted code fills every box", async ({ page }) => {
  await page.waitForTimeout(31_000 - (Date.now() % 30_000)); // next TOTP step: the last code was consumed (replay guard)
  await password(page, E2E_PASSWORD);
  await page.getByLabel("Digit 1").focus();
  await page.evaluate((c) => {
    const dt = new DataTransfer();
    dt.setData("text", c);
    document.activeElement?.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, code());
  await expect(page).toHaveURL(/\/$/);
});
