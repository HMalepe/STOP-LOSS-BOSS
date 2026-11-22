import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `pnpm load`: the 1,000-item load scenarios (virtual time, so they finish in seconds). */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/load/**/*.test.ts"],
    testTimeout: 120_000,
    reporters: ["default"],
  },
});
