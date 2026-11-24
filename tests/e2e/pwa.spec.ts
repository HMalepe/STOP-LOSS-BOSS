import { expect, test } from "@playwright/test";

test("installable: manifest with real icons (maskable too), standalone, dark", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const m = (await res.json()) as {
    display: string;
    theme_color: string;
    icons: { src: string; purpose: string; sizes: string }[];
  };
  expect(m.display).toBe("standalone");
  expect(m.theme_color).toBe("#0a0d11");
  expect(m.icons.map((i) => `${i.sizes}:${i.purpose}`).sort()).toEqual([
    "192x192:any",
    "512x512:any",
    "512x512:maskable",
  ]);
  for (const i of m.icons) {
    const img = await request.get(i.src);
    expect([img.status(), img.headers()["content-type"]]).toEqual([200, "image/png"]);
  }
});

test("the service worker caches the shell only, never the API", async ({ request }) => {
  const sw = await (await request.get("/sw.js")).text();
  expect(sw).toContain(`if (url.pathname.startsWith("/api/")) return;`);
  // The only cache writes are for hashed build assets.
  expect(sw.match(/c\.put\(/g)).toHaveLength(1);
  expect(sw).toContain(`if (url.pathname.startsWith("/_next/static/")) {`);
});

test("offline: a dead connection shows the offline page, not a browser error", async ({ page, context }) => {
  await page.goto("/login");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // now controlled by the worker
  await context.setOffline(true);
  await page.goto("/login").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await expect(page.getByText("Nothing is sent while you're offline.")).toBeVisible();
  // Styled even offline: its stylesheet comes from the cache (dark background, not the browser default white).
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 13, 17)");
  await context.setOffline(false);
});
