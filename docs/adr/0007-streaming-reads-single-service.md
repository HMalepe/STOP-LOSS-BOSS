# ADR-0007: Reads come from the stream; consider one always-on service from day one
**Status:** accepted 2026-11-21 (both parts). Supersedes the hosting part of ADR-0003.
**Context:** Verified MetaApi limits: 5,000 credits per account per 10 s, a trade costs 10 credits, streaming terminal state costs 0.
A 1,000-position close needs ~10,000 credits for the trades alone, which is already over one 10 s window. Every REST read of positions or
quotes during a batch takes credits from the trades. ADR-0003 deferred the warm streaming worker to Phase 9, so Phases 4 to 8 would
execute over REST from serverless with cold starts, and would be measuring performance on an architecture that gets replaced.
**Decision:** (1) Accepted: during preview and execute, positions, quotes and specs come from streamed state wherever available; REST
reads only as a fallback. (2) Proposed: run Next.js **and** the executor as one always-on Node service (Railway or Fly, region near the
MetaApi region) from Phase 3, holding the streaming connection. Supabase stays for data and Realtime. `JobRunner` stays as the seam.
Vercel becomes optional.
**Consequences:** One deploy target instead of two, a warm connection from the first real test, and measurements that stay valid.
It costs a small always-on instance, which a warm MetaApi connection needs anyway. If the owner prefers Vercel, ADR-0003 stands
and this ADR shrinks to point (1).
