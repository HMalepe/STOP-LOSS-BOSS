# ADR-0003: Long-running execution worker
**Status:** accepted; hosting amended by ADR-0007 (one always-on Node service holding the stream from Phase 3, `JobRunner` seam kept)
**Context:** Serverless cold starts and time limits hurt bulk execution latency; a warm streaming MetaApi connection is faster.
**Decision:** `JobRunner` interface. `InProcessRunner` (Phases 4 to 8) and `WorkerRunner` (Phase 9): Next.js enqueues to Supabase, worker picks up, executes, and streams progress via Supabase Realtime.
**Consequences:** One extra service to deploy. Large batches no longer bounded by function timeouts.
