> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 10: Hardening and go-live readiness

**M1. Chaos.** Broker disconnect mid-batch, worker restart mid-batch, DB unavailable (refuse to trade), timeout-after-broker-acted (reconcile from positions, don't resend blindly). /checkpoint.
**M2. Coverage + deps.** Thresholds met, E2E green, dependency audit, remove unused deps. /checkpoint.
**M3. Final board review** of the whole repo. Fix every critical and high finding. /checkpoint.
**M4. docs/OPERATING.md** in the voice from 10-VOICE: how to use each feature, the two latencies, what to do when something fails, the kill switch, and how presets work. /checkpoint.
**M5. Go-live checklist** from 08: mark what's done and what I must do myself. /checkpoint.

Final report to me: what's production-ready, what isn't, and my exact next steps. Human, short, honest.
