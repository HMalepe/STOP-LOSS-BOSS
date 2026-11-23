-- Phase 05 security review.

-- Per-user budget for second-factor failures (independent of IP) and failed re-auths per session.
alter table login_attempts add column user_id uuid references users (id) on delete set null;
create index login_attempts_user_failed on login_attempts (user_id, at) where ok = false;
alter table sessions add column reauth_failures int not null default 0;

-- The owner is rotated in place now; these references must never block that (or a delete).
alter table config drop constraint config_updated_by_fkey;
alter table config add constraint config_updated_by_fkey foreign key (updated_by) references users (id) on delete set null;

-- Supabase's API roles get nothing at all (RLS without policies already blocks rows; this removes table rights too,
-- including TRUNCATE, which RLS doesn't cover). No-ops where the roles don't exist (local Postgres, PGlite).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
  end if;
end
$$;

-- Least-privilege role for the running app (docs/08-DEPLOYMENT.md: give it LOGIN + a password, point DATABASE_URL at it,
-- run migrations with the owner role). It can't alter tables or disable triggers, and on audit_log it can only read and append.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'order_desk_app') then
    create role order_desk_app nologin;
  end if;
end
$$;
grant usage on schema public to order_desk_app;
grant select, insert, update, delete on users, recovery_codes, sessions, pending_logins, login_attempts, accounts, config, plans, executions, execution_items, presets to order_desk_app;
grant select, insert on audit_log to order_desk_app;
grant usage, select on all sequences in schema public to order_desk_app;
grant select on schema_migrations to order_desk_app;
