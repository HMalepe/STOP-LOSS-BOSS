/**
 * Proves the architecture guardrails actually fire. If someone weakens eslint/boundaries.ts, this goes red.
 */
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { boundaries } from "../../../eslint/boundaries";

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  overrideConfig: [{ files: ["**/*.{ts,tsx}"], languageOptions: { parser: tseslint.parser } }, ...boundaries],
});

async function ruleHits(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "fatal");
}

describe("ADR-0002: MetaApi SDK only inside src/broker", () => {
  const code = `import MetaApi from "metaapi.cloud-sdk";\nexport const x = MetaApi;\n`;

  it.each(["src/server/plans/x.ts", "src/execution/x.ts", "src/app/api/x/route.ts", "worker/main.ts"])(
    "blocks it in %s",
    async (file) => {
      expect(await ruleHits(code, file)).toContain("no-restricted-imports");
    },
  );

  it("allows it in src/broker", async () => {
    expect(await ruleHits(code, "src/broker/MetaApiBroker.ts")).toEqual([]);
  });
});

describe("src/domain is pure", () => {
  const file = "src/domain/rules.ts";

  it.each([
    `import { z } from "zod";`,
    `import fs from "node:fs";`,
    `import { env } from "@/server/env";`,
    `import { x } from "@/broker/MockBroker";`,
    `import React from "react";`,
  ])("rejects impure import: %s", async (line) => {
    expect(await ruleHits(`${line}\n`, file)).toContain("no-restricted-imports");
  });

  it.each([
    `import { a } from "./price";`,
    `import { b } from "../domain/types";`,
    `import { c } from "@/domain/price";`,
  ])("allows domain import: %s", async (line) => {
    expect(await ruleHits(`${line}\n`, file)).toEqual([]);
  });

  it.each([
    "export const t = Date.now();",
    "export const d = new Date();",
    "export const r = Math.random();",
    "export const e = process.env.X;",
    "export const f = () => fetch('x');",
    "export const s = () => setTimeout(() => 0, 1);",
  ])("rejects impure syntax: %s", async (code) => {
    expect(await ruleHits(code, file)).toContain("no-restricted-syntax");
  });

  it("does not police other layers' syntax", async () => {
    expect(await ruleHits("export const t = Date.now();", "src/server/clock.ts")).toEqual([]);
  });
});

describe("UI never reaches the broker or executor", () => {
  it.each([`import { x } from "@/broker/MockBroker";`, `import { y } from "@/execution/executor";`])(
    "src/ui rejects %s",
    async (line) => {
      expect(await ruleHits(line, "src/ui/Button.tsx")).toContain("no-restricted-imports");
    },
  );

  it("src/ui may not import server internals either", async () => {
    expect(await ruleHits(`import { e } from "@/server/env";`, "src/ui/Badge.tsx")).toContain(
      "no-restricted-imports",
    );
  });

  it("src/app may use src/server but not the broker", async () => {
    expect(await ruleHits(`import { e } from "@/server/env";`, "src/app/page.tsx")).toEqual([]);
    expect(await ruleHits(`import { b } from "@/broker/x";`, "src/app/page.tsx")).toContain(
      "no-restricted-imports",
    );
  });
});
