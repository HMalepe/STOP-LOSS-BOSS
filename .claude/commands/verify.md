---
description: Run all quality gates and report
---
Run `pnpm verify`. If anything fails, fix it (don't skip or weaken tests or lint rules) and re-run until it is green.
Then report: typecheck, lint, test counts, coverage for src/domain and src/execution, build status. Note any test that was changed and why.
