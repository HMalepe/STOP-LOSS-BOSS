> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 00: Kickoff and board review

Read CLAUDE.md, docs/00-SESSION-PROTOCOL.md, docs/10-VOICE.md, every other file in docs/ (including adr/), and skim reference/v1-prototype/.
No code this phase.

**M1. Understand.** Tell me in one short paragraph, in plain words, what we're building and what makes the Order Desk the game-changer.

**M2. Board review of the spec.** Run /board-review on the docs themselves. I want:
- anything in 03-TRADING-RULES.md or 11-ORDER-DESK.md that's wrong, ambiguous or missing (trading-systems-engineer leads)
- architecture risks (principal-architect)
- scope cuts for a first usable version (product-lead)
- the list of MetaApi facts to verify before Phase 3

**M3. Questions.** Max 5 questions for me, each with your recommendation.

When I answer: update the docs, write ADRs for decisions, fill PROGRESS.md (decisions, open questions), /checkpoint, then /handoff.
