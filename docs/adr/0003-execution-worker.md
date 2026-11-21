# ADR-0003: Long-running execution worker
**Status:** accepted (implemented Phase 9; in-process runner before that)
**Context:** Serverless cold starts and time limits hurt bulk execution latency; a warm streaming MetaApi connection is faster.
**Decision:** `JobRunner` interface. `InProcessRunner` (Phases 4 to 8) and `WorkerRunner` (Phase 9): Next.js enqueues to Supabase, worker picks up, executes, and streams progress via Supabase Realtime.
**Consequences:** One extra service to deploy. Large batches no longer bounded by function timeouts.
