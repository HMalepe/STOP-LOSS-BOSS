> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 01: Foundation
Read: docs/02-ARCHITECTURE.md, docs/06-TESTING.md, docs/08-DEPLOYMENT.md.

**M1. Project skeleton.** Next.js App Router + TS strict (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes), pnpm, folder layout from 02. /checkpoint.
**M2. Quality gates.** ESLint (typescript-eslint strict, import rules, a rule banning the MetaApi SDK outside src/broker), Prettier, Vitest with coverage thresholds, Playwright with a 390×844 project, `pnpm verify`. GitHub Actions CI. /checkpoint.
**M3. Env + logging.** `src/server/env.ts` Zod schema (fails fast, clear message), `.env.example`, Pino logger with secret redaction plus a test proving redaction. /checkpoint.
**M4. Design tokens.** Tailwind with the colour, spacing and type tokens from 07-UI-SPEC as CSS variables, plus a placeholder home page showing the mode badge. /checkpoint.

Done when a clean clone passes `pnpm verify`. Then /handoff.
