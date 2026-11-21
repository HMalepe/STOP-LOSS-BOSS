import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundaries } from "./eslint/boundaries";
import { orderDeskPlugin } from "./eslint/rules/no-raw-price-compare";

export default defineConfig(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "reference/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-console": "error",
      curly: ["error", "multi-line"],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], extends: [tseslint.configs.disableTypeChecked] },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  { ...reactHooks.configs.flat.recommended, files: ["src/app/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"] },
  boundaries,
  {
    name: "order-desk/no-raw-price-compare",
    files: ["src/**/*.{ts,tsx}", "worker/**/*.ts"],
    ignores: ["src/domain/price.ts"],
    plugins: { "order-desk": orderDeskPlugin },
    rules: { "order-desk/no-raw-price-compare": "error" },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
);
