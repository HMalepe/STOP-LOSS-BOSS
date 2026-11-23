import { expect, test } from "@playwright/test";

test("pages carry a per-request nonce CSP and still render with zero CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const res1 = await page.goto("/");
  const csp1 = res1?.headers()["content-security-policy"] ?? "";
  expect(csp1).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp1).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: "Order Desk" })).toBeVisible();

  const res2 = await page.goto("/");
  const csp2 = res2?.headers()["content-security-policy"] ?? "";
  expect(csp2).not.toBe(csp1); // a fresh nonce every time
  expect(violations).toEqual([]);
});

test("isolation headers are set on every response", async ({ request }) => {
  const res = await request.get("/");
  expect(res.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(res.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
});

test("API: unauthenticated and cross-origin requests are refused", async ({ request }) => {
  const anon = await request.get("/api/admin/kill-switch");
  expect(anon.status()).toBe(401);
  const csrf = await request.post("/api/auth/login", {
    data: { password: "x" },
    headers: { origin: "https://evil.example" },
  });
  expect(csrf.status()).toBe(403);
});
