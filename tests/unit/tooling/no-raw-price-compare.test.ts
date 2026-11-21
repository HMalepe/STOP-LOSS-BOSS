import path from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noRawPriceCompare } from "../../../eslint/rules/no-raw-price-compare";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: path.join(import.meta.dirname, "fixtures"),
    },
  },
});

const PRELUDE = `type Price = number & { readonly __brand: "Price" };
type Points = number & { readonly __brand: "Points" };
declare const a: Price; declare const b: Price; declare const n: number; declare const p: Points; declare const q: Points;
declare const maybe: Price | null;
`;

tester.run("no-raw-price-compare", noRawPriceCompare, {
  valid: [
    `${PRELUDE} const ok = p < q;`,
    `${PRELUDE} const ok = n < 1.5;`,
    `${PRELUDE} const sum = a + b;`,
    `${PRELUDE} const isNull = maybe === null;`,
    `${PRELUDE} const isNull = maybe == undefined;`,
    `${PRELUDE} const isNull = null !== maybe;`,
    `${PRELUDE} const s = "x" === "y";`,
  ],
  invalid: [
    { code: `${PRELUDE} const bad = a < b;`, errors: [{ messageId: "raw", data: { op: "<" } }] },
    { code: `${PRELUDE} const bad = a === b;`, errors: [{ messageId: "raw", data: { op: "===" } }] },
    { code: `${PRELUDE} const bad = a >= n;`, errors: [{ messageId: "raw", data: { op: ">=" } }] },
    { code: `${PRELUDE} const bad = n !== b;`, errors: [{ messageId: "raw", data: { op: "!==" } }] },
    { code: `${PRELUDE} const bad = maybe === a;`, errors: [{ messageId: "raw", data: { op: "===" } }] },
    { code: `${PRELUDE} const bad = maybe! > 1.08;`, errors: [{ messageId: "raw", data: { op: ">" } }] },
  ],
});
