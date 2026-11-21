---
description: Start a build phase by number (e.g. /phase 3)
argument-hint: <phase number 0-10>
---
1. Do /resume first if you haven't this session.
2. Open prompts/ file starting with the zero-padded "$ARGUMENTS". Confirm the previous phase is ✅ in PROGRESS.md and `pnpm verify` is green; if not, stop and tell me.
3. Mark the phase 🟨 in PROGRESS.md.
4. Work its milestones in order using the loop in docs/00-SESSION-PROTOCOL.md: plan, build with tests, /checkpoint. Take breaks per the break rules.
5. When all milestones are done: run the reviews the prompt asks for, fix, mark ✅, write a handoff.
