-- Order Desk schema (docs/02-ARCHITECTURE.md data model, docs/05-SECURITY.md).
-- Conventions: every secret-ish value is stored hashed or encrypted by the app; timestamps are timestamptz; ids are text/uuid.
-- Row-level security is enabled on EVERY table with no policies: Supabase's anon/authenticated API keys can read nothing.
-- The server connects with its own role. Note: Supabase's service role bypasses RLS, so the audit log is protected by a trigger
-- as well (it fires for everyone, owner included).

create table users (
  id uuid primary key default gen_random_uuid(),
  password_hash text not null,
  -- AES-256-GCM, key derived from SESSION_SECRET (src/server/auth/crypto.ts)
  totp_secret_enc text not null,
  -- Last accepted TOTP time step: a code can be used once (replay protection).
  totp_last_step bigint not null default 0,
  created_at timestamptz not null default now()
);

create table recovery_codes (
  id bigint generated always as identity primary key,
  user_id uuid not null references users (id) on delete cascade,
  code_hash text not null unique,
  used_at timestamptz
);

create table sessions (
  -- sha256 of the 256-bit session id; the raw id only ever lives in the cookie.
  id_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  absolute_expires_at timestamptz not null,
  -- Last successful TOTP re-auth: sensitive changes need one within the last few minutes.
  reauth_at timestamptz,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index sessions_user on sessions (user_id);

-- Step 1 (password OK) → step 2 (TOTP). Short-lived, hashed, single use.
create table pending_logins (
  id_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  attempts int not null default 0
);

create table login_attempts (
  id bigint generated always as identity primary key,
  ip text not null,
  stage text not null check (stage in ('password', 'totp')),
  ok boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_ip_at on login_attempts (ip, at);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  metaapi_account_id text not null unique,
  label text not null default '',
  -- Live is opt-in twice: TRADING_MODE=live AND this flag (CLAUDE.md non-negotiable 2). Flipped only with re-auth.
  live_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- Caps and the DB kill switch. Changes need re-auth and are audited.
create table config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users (id)
);

create table plans (
  id text primary key,
  user_id uuid not null references users (id),
  account_id uuid references accounts (id),
  action text not null,
  params jsonb not null,
  -- The exact items the preview showed. Execute runs THESE, never items from a request (non-negotiable 1).
  items jsonb not null,
  input_hash text not null,
  group_tag text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'created' check (status in ('created', 'executing', 'executed', 'expired'))
);
create index plans_user_created on plans (user_id, created_at desc);

create table executions (
  id uuid primary key,
  -- Non-negotiable 7: one execution per plan, enforced by the database.
  plan_id text not null unique references plans (id),
  status text not null default 'running' check (status in ('running', 'complete', 'interrupted')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb
);

-- One row per item, written BEFORE the send ("sending") and updated after, so a restart knows what may be in flight.
create table execution_items (
  execution_id uuid not null references executions (id) on delete cascade,
  idx int not null,
  op text not null,
  target_id text not null,
  state text not null default 'pending'
    check (state in ('pending', 'sending', 'done', 'failed', 'unknown', 'skipped')),
  code int,
  string_code text,
  message text,
  attempts int not null default 0,
  latency_ms int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (execution_id, idx)
);

create table presets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  recipe jsonb not null,
  pinned boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only and tamper-evident: each row stores the hash of the previous row's hash + its own content (app computes it).
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject text,
  details jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null unique
);

create function audit_log_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update before update on audit_log
  for each row execute function audit_log_is_append_only();
create trigger audit_log_no_delete before delete on audit_log
  for each row execute function audit_log_is_append_only();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_is_append_only();

alter table users enable row level security;
alter table recovery_codes enable row level security;
alter table sessions enable row level security;
alter table pending_logins enable row level security;
alter table login_attempts enable row level security;
alter table accounts enable row level security;
alter table config enable row level security;
alter table plans enable row level security;
alter table executions enable row level security;
alter table execution_items enable row level security;
alter table presets enable row level security;
alter table audit_log enable row level security;
