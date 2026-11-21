/**
 * Bans <, >, <=, >=, ==, ===, !=, !== when either side is a branded `Price`.
 * Prices are floats: compare them in integer points via comparePrices / pricesEqual (src/domain/price.ts).
 */
import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type { ESLint, Rule } from "eslint";
import type ts from "typescript";

const COMPARISONS = new Set(["<", ">", "<=", ">=", "==", "===", "!=", "!=="]);

const createRule = ESLintUtils.RuleCreator(() => "docs/03-TRADING-RULES.md#0-definitions");

export const noRawPriceCompare = createRule({
  name: "no-raw-price-compare",
  meta: {
    type: "problem",
    docs: { description: "Disallow comparing Price values directly; compare in points." },
    messages: {
      raw: "Don't compare Price values with '{{op}}'. Use comparePrices/pricesEqual from src/domain/price.ts (integer points).",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    const isPrice = (type: ts.Type): boolean => {
      if (type.isUnion() || type.isIntersection()) {
        if (type.types.some(isPrice)) return true;
      }
      const brand = type.getProperty("__brand");
      if (brand === undefined) return false;
      const brandType = checker.getTypeOfSymbol(brand);
      return brandType.isStringLiteral() && brandType.value === "Price";
    };

    /** `x === null` / `x == undefined` are presence checks, not float comparisons. */
    const isNullish = (node: TSESTree.Node): boolean =>
      (node.type === AST_NODE_TYPES.Literal && node.value === null) ||
      (node.type === AST_NODE_TYPES.Identifier && node.name === "undefined");

    return {
      BinaryExpression(node: TSESTree.BinaryExpression) {
        if (!COMPARISONS.has(node.operator)) return;
        if (node.left.type === AST_NODE_TYPES.PrivateIdentifier) return;
        if (isNullish(node.left) || isNullish(node.right)) return;
        if (
          isPrice(services.getTypeAtLocation(node.left)) ||
          isPrice(services.getTypeAtLocation(node.right))
        ) {
          context.report({ node, messageId: "raw", data: { op: node.operator } });
        }
      },
    };
  },
});

// typescript-eslint's RuleModule and ESLint's Rule.RuleModule describe the same runtime object with
// different context types (a known gap between the two packages), hence the one cast here.
export const orderDeskPlugin: ESLint.Plugin = {
  meta: { name: "order-desk" },
  rules: { "no-raw-price-compare": noRawPriceCompare as unknown as Rule.RuleModule },
};
