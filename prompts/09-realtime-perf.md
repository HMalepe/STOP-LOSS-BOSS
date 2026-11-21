> Session rules: /resume first if this is a fresh session. Work ONE milestone at a time, then /checkpoint. Take a break (/handoff) per docs/00-SESSION-PROTOCOL.md. Talk to me per docs/10-VOICE.md.

# Phase 09: Realtime and performance
Read: docs/09-PERFORMANCE.md, ADR-0003, docs/11-ORDER-DESK.md speed path.

**M1. Worker.** Long-running Node service: warm MetaApi streaming connection, consumes jobs from Supabase, runs the existing executor, publishes progress via Realtime; health endpoint; graceful shutdown finishing in-flight items. /checkpoint.
**M2. WorkerRunner** behind JobRunner, switched by env; resume-or-report on restart, never double-act. /checkpoint.
**M3. Live dashboard.** Streamed quotes and positions (no polling), reconnect indicator, cached spec refreshed from the stream. /checkpoint.
**M4. Tune and measure.** Set the limiter to the verified limits. `pnpm load` with realistic latency. If demo creds exist, measure real 10/50/100/500 modifies and 10/50/100 entries on the Exness demo. Record everything in 09. /checkpoint.
**M5. Deploy docs** for the worker (Railway or Fly, region choice reasoning) in 08. /checkpoint.

Phase end: the sre-reliability and trading-systems-engineer agents. /handoff.
