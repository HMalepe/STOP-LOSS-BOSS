import { expect, test } from "@playwright/test";

test("home renders on a phone with the mode badge and no horizontal scroll", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Order Desk" })).toBeVisible();

  const badge = page.getByRole("status", { name: /mock mode/i });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("MOCK");

  await expect(page.getByText("Safety limits per action")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Trading halted" })).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("security headers are set", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["x-frame-options"]).toBe("DENY");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  expect(res.headers()["x-powered-by"]).toBeUndefined();
});
