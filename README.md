# Order Desk: Claude Code Build Kit (v2)

A full blueprint for Claude Code to build a state-of-the-art, phone-first trade-management machine on your Exness MT5 account
(via MetaApi): **fire many orders in one tap**, manage them as one batch, and exit everything at a price or instantly.

Written as the brief a top engineering team would hand over: principal architect, trading-systems engineer, security engineer,
SRE, QA lead, product designer and product lead. Each one is a Claude Code sub-agent in `.claude/agents/` that reviews the work.

## What's new in v2
- **Breaks and refresh built in.** Claude works in milestones, checkpoints after each one, writes handoff notes, and tells you when to `/clear`. Files are the memory (`PROGRESS.md`, `docs/handoffs/`), so a fresh session picks up exactly where the last left off.
- **Human voice.** `docs/10-VOICE.md` keeps Claude talking like a sharp senior dev mate, not a bot.
- **Expert board.** `/board-review` runs all seven roles and merges their findings into one action list.
- **Order Desk.** `docs/11-ORDER-DESK.md` covers bulk entries, scaled ladders, one-tap presets, quick-fire buttons, batch management by tag, risk and margin preview, and a spread guard.

## Layout
```
CLAUDE.md                 Rules Claude Code loads every session (roles, protocol, non-negotiables)
PROGRESS.md               Live build tracker. Claude updates it every checkpoint
docs/
  00-SESSION-PROTOCOL.md  How Claude works in milestones, takes breaks, resumes
  01-PRD.md … 09-PERFORMANCE.md   Product, architecture, trading rules, API, security, tests, UI, deploy, speed
  10-VOICE.md             How Claude talks to you
  11-ORDER-DESK.md        The game-changer feature spec
  adr/                    Why key decisions were made
  handoffs/               Session handoff notes (template inside)
prompts/00 … 10           One per phase, split into milestones
.claude/commands/         /resume /phase /checkpoint /handoff /verify /safety-review /board-review /status
.claude/agents/           principal-architect, trading-systems-engineer, security-engineer, sre-reliability,
                          qa-lead, product-designer, product-lead, trading-safety-reviewer, test-engineer
reference/v1-prototype/   Your working demo app (logic reference)
```

## How to run it
1. Unzip, open a terminal in the folder: `git init && git add -A && git commit -m "kit"`, then `claude`.
2. Paste `prompts/00-kickoff.md`. Answer its questions.
3. Each session after that:
   - `/resume` → Claude tells you where things stand
   - `/phase N` → it works milestone by milestone, `/checkpoint` after each
   - when it says "good spot to pause": `/clear`, then `/resume` next time
4. Reviews: `/safety-review` after trading logic, `/board-review` at the end of each phase.

## The rhythm
```
/resume → milestone → /checkpoint → milestone → /checkpoint → /handoff → /clear → (break) → /resume …
```

## Golden rules
- Demo account first. Live needs an env flag and a DB flag, plus re-auth.
- Every action previews; what you preview is exactly what runs.
- No order ever goes out without its stop.
- If Claude wants to skip a test on trading logic, the answer is no.
