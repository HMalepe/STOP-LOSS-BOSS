import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const STRICT = { branches: 95, functions: 95, lines: 95, statements: 95 };

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/execution/**/*.ts", "src/server/**/*.ts"],
      reporter: ["text", "html"],
      thresholds: {
        // CLAUDE.md non-negotiable 10: money logic is held to 95%+.
        "src/domain/**": STRICT,
        "src/execution/**": STRICT,
        "src/server/**": { branches: 85, functions: 85, lines: 85, statements: 85 },
      },
    },
  },
});
