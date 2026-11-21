> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 06: API routes
Read: docs/04-API-SPEC.md exactly.

**M1. State + positions routes.** Fresh data loaded in parallel, spec cached per symbol. /checkpoint.
**M2. Plans.** Create (dry-run) → persist with input hash and 30s TTL → PlanSummary; 422 PLAN_INVALID with grouped details. /checkpoint.
**M3. Execute.** Expiry, already-executed, kill switch, mode guard, drift guard (R7) → JobRunner → 202. SSE progress stream. /checkpoint.
**M4. Close-now, retry-failed, history, kill switch admin.** /checkpoint.
**M5. Contract.** Integration tests for every error code in 04; OpenAPI generated from Zod into docs/openapi.json. /checkpoint.

Phase end: security-engineer and qa-lead agents. /handoff.
