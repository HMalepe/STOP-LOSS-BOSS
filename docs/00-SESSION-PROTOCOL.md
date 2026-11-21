# 00: Session Protocol (how Claude works without burning out its context)

Long sessions degrade: the context fills, early instructions fade, and quality drops quietly. This project is built in
short, sharp sessions that hand off cleanly. The files are the memory, not the chat.

## The loop
```
/resume → plan the milestone (3–6 lines) → build with tests → /verify → /checkpoint → (next milestone or /handoff + break)
```

## Milestone size
One milestone = one coherent unit you could review in 10 minutes: e.g. "price.ts + its tests", "token-bucket limiter + tests",
"Trigger tab UI + E2E". Each phase prompt in `prompts/` lists its milestones. Don't merge milestones to "save time".

## When to take a break (any one is enough)
- The milestone is done and checkpointed.
- You've done roughly 2 to 3 milestones in this session.
- You're re-reading files you already read, or you've tried the same fix twice.
- You're unsure what an earlier instruction said. That's a sign the context is stale.
- A test is failing and you don't know why after two hypotheses. Write down both hypotheses in the handoff and stop.

Taking a break = run `/handoff`, then tell the owner in one line:
"Good spot to pause. Run `/clear`, then `/resume` when you're ready."

## /resume (start of every session)
1. Read `CLAUDE.md`, `PROGRESS.md`, the newest file in `docs/handoffs/`.
2. `git status` and `git log --oneline -10`.
3. Run `pnpm verify` (if the project exists yet).
4. Tell the owner in 2 to 3 lines: where we are, what's next, anything broken.
5. Re-read only the docs the current phase names. Don't load everything "just in case".

## /checkpoint (end of every milestone)
1. `pnpm verify` green. If red, fix or stop and hand off. Never commit red.
2. Commit with a conventional message.
3. Update `PROGRESS.md` (Now, the phase row, the decisions log).

## Refresh rules
- Before each new milestone, re-read the specific rule IDs or spec sections it touches, even if you "remember" them.
- Every ~3 milestones, re-read `CLAUDE.md` non-negotiables.
- Before touching trading logic, re-read `docs/03-TRADING-RULES.md` for the rules involved.

## Thinking discipline
- Before coding a milestone, write the plan: files, tests, risks, and "what would make this wrong".
- For anything with money consequences, think through both buy and sell, and exactly-at-boundary, one-inside and one-outside cases.
- When stuck, step back to the spec rather than adding more code.
