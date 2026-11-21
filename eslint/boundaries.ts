/**
 * Architecture boundaries from CLAUDE.md, enforced by lint.
 * Kept separate from eslint.config.ts so tests/unit/tooling/boundaries.test.ts can prove each rule fires.
 */
import type { Linter } from "eslint";

const METAAPI = {
  group: ["metaapi.cloud-sdk", "metaapi.cloud-sdk/*"],
  message: "Only src/broker may import the MetaApi SDK (ADR-0002). Go through BrokerProvider.",
};

/** src/domain may import only relative files or other domain files. Nothing else, ever. */
const DOMAIN_ONLY = {
  regex: String.raw`^(?!\.{1,2}/|@/domain/)`,
  message: "src/domain is pure: relative or @/domain imports only. No packages, no node:*, no other layers.",
};

const UI_FORBIDDEN = {
  group: ["@/broker", "@/broker/*", "@/execution", "@/execution/*", "@/server", "@/server/*"],
  message: "src/ui is presentational: it never talks to the broker, executor or server internals.",
};

const APP_FORBIDDEN = {
  group: ["@/broker", "@/broker/*", "@/execution", "@/execution/*"],
  message: "Routes and pages go through src/server, never straight to the broker or executor.",
};

const IMPURE_SYNTAX: Linter.RuleEntry = [
  "error",
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "No Date.now() in src/domain. Take a Clock.",
  },
  { selector: "NewExpression[callee.name='Date']", message: "No new Date() in src/domain. Take a Clock." },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "No Math.random() in src/domain. Inject a seeded source.",
  },
  {
    selector: "MemberExpression[object.name='process']",
    message: "No process.* in src/domain. Pass config in.",
  },
  { selector: "CallExpression[callee.name='fetch']", message: "No I/O in src/domain." },
  {
    selector: "CallExpression[callee.name=/^set(Timeout|Interval|Immediate)$/]",
    message: "No timers in src/domain.",
  },
];

export const boundaries: Linter.Config[] = [
  {
    name: "order-desk/metaapi-only-in-broker",
    files: ["**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [METAAPI] }] },
  },
  {
    name: "order-desk/broker-may-use-metaapi",
    files: ["src/broker/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    name: "order-desk/domain-is-pure",
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [DOMAIN_ONLY] }],
      "no-restricted-syntax": IMPURE_SYNTAX,
    },
  },
  {
    name: "order-desk/ui-is-presentational",
    files: ["src/ui/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [METAAPI, UI_FORBIDDEN] }] },
  },
  {
    name: "order-desk/app-goes-through-server",
    files: ["src/app/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [METAAPI, APP_FORBIDDEN] }] },
  },
];
