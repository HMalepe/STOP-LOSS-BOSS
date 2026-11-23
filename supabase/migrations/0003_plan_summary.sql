-- Phase 06 M2: GET /api/plans/:id returns exactly what the preview showed, so the summary is stored with the items.
alter table plans add column summary jsonb not null default '{}'::jsonb;
alter table plans add column symbol text not null default '';
