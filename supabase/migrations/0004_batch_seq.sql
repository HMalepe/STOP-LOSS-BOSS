-- Phase 08 M3 (R9.1): batch identity. magic = APP_MAGIC_PREFIX × 10^9 + nextval; the short tag is the value in base 36.
-- A sequence, not max()+1: two previews at once must never share a batch, and gaps are harmless.
create sequence batch_seq start 1 maxvalue 999999999 no cycle;
-- 0002 granted sequences that existed then; new ones need their own grant.
grant usage, select on sequence batch_seq to order_desk_app;
