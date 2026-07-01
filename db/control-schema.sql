-- Control-plane schema. Run this on your own database.
-- Stores tenants, connected Supabase projects, encrypted credentials,
-- schema cache, and query audit logs. It does not store client table data.

create table if not exists tenants (
  id               bigint generated always as identity primary key,
  telegram_user_id bigint unique not null,
  display_name     text,
  plan             text not null default 'free',
  created_at       timestamptz not null default now()
);

create table if not exists projects (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants(id) on delete cascade,
  label         text not null,
  conn_enc      text not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (tenant_id, label)
);

-- Cached schema metadata per connected project.
create table if not exists schema_cache (
  project_id    bigint primary key references projects(id) on delete cascade,
  tables_json   jsonb not null,
  refreshed_at  timestamptz not null default now()
);

-- Audit log of every question asked.
create table if not exists queries_log (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null references tenants(id) on delete cascade,
  project_id    bigint references projects(id) on delete set null,
  question      text not null,
  generated_sql text,
  row_count     integer,
  success       boolean not null default false,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_projects_tenant on projects(tenant_id);
create index if not exists idx_queries_tenant on queries_log(tenant_id);
