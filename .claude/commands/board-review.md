---
description: Convene the expert board on the current phase or a design question
argument-hint: [optional topic]
---
Run these agents on the current phase's changes (or on "$ARGUMENTS" if given): principal-architect, trading-systems-engineer,
security-engineer, sre-reliability, qa-lead, product-designer (only if UI changed), product-lead.
Run independent ones in parallel. Then act as chair: merge the findings, drop duplicates, resolve disagreements with a one-line reason,
and give me one ranked action list (must-fix now / fix this phase / later). Fix the must-fix items, then /verify.
Keep the summary to me human and short (docs/10-VOICE.md).
