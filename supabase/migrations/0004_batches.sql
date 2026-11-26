-- Phase 08: batch identity (R9.1). One sequence for the whole app: atomic, never reused, no cycle (a batch keeps its number
-- even if retried). magic = APP_MAGIC_PREFIX × 10^9 + batch_seq, so batch_seq must stay below 10^9.
create sequence batch_seq minvalue 1 maxvalue 999999999 no cycle;
alter table plans add column batch_seq bigint;
create index plans_batch_seq on plans (batch_seq) where batch_seq is not null;
grant usage, select on sequence batch_seq to order_desk_app;
