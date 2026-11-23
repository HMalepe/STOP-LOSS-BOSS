import { defineConfig } from "@playwright/test";
import { E2E_DB_DIR, E2E_SESSION_SECRET } from "./tests/e2e/fixtures";

const PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [
    {
      // The owner's real device class: one thumb, 390×844.
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      },
    },
  ],
  webServer: {
    // A fresh embedded database with a known owner, then the production build.
    command: `pnpm exec tsx scripts/e2e-seed.ts && pnpm exec next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse: the seed must run, and a stale server would hold an old database.
    reuseExistingServer: false,
    env: {
      TRADING_MODE: "mock",
      SESSION_SECRET: E2E_SESSION_SECRET,
      DATABASE_URL: `pglite://${E2E_DB_DIR}`,
    },
  },
});
