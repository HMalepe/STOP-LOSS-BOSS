# ADR-0005: Batches are identified by magic number, not comment
**Status:** accepted
**Context:** The original spec tagged batches through `comment` (`OD:<id>`). Comments are fragile: MetaApi caps `comment` + `clientId`
at 26 characters combined [verified], a comment can't be changed after entry, and some brokers truncate or rewrite comments on fills or
SL/TP hits. A batch-management action ("close this batch") that matches on a damaged comment would miss positions or, worse, hit the wrong ones.
**Decision:** `magic = APP_MAGIC_PREFIX × 10^9 + batchSeq`. The magic is a number set once at entry and carried by the position. It identifies
both "this app opened it" and "which batch". The comment stays as a human label only. `clientId` carries `<planShort><itemIndex>` for
reconciliation after an ambiguous timeout (R6.5). All matching goes through one pure function `decodeMagic()` with property tests.
**Consequences:** Max ~10^9 batches per prefix, which is plenty. Must confirm in Phase 3 that MetaApi accepts `magic` on market and pending
orders and returns it on positions. Manual trades (magic 0) and other EAs can never be touched by batch actions.
