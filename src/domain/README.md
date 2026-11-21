# src/domain: pure trading logic
- No I/O, no framework, no packages. Relative imports only (lint-enforced).
- No `Date.now()`, `new Date()`, `Math.random()`, `process.env` (lint-enforced). Time comes in through a `Clock`.
- Every rule in `docs/03-TRADING-RULES.md` lives here, with a test named after its rule ID.
- TDD only. Coverage gate: 95% branches.
