-- Engine schema 0001 (spec 7.1). The runner bootstraps `migrations` itself; this is idempotent.
create table if not exists migrations (
  name text primary key,
  applied_at timestamptz not null default clock_timestamp()
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  deleted_at timestamptz null,
  deleted_by text null
);
create index idx_documents_collection on documents (collection) where deleted_at is null;

create table document_shared (
  id bigint generated always as identity primary key,
  doc_id uuid not null references documents (id) on delete cascade,
  version int not null,
  state text not null check (state in ('PUBLISHED', 'DRAFT_HUMAN', 'APPROVED')),
  data jsonb not null default '{}'::jsonb,
  is_head_published boolean not null default false,
  is_head_draft boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  published_at timestamptz null,
  published_by text null,
  unpublished_at timestamptz null,
  unpublished_by text null,
  constraint uq_document_shared_version unique (doc_id, version)
);
create unique index uq_doc_shared_head_published on document_shared (doc_id) where is_head_published;
create unique index uq_doc_shared_head_draft on document_shared (doc_id) where is_head_draft;

create table document_localized (
  id bigint generated always as identity primary key,
  doc_id uuid not null references documents (id) on delete cascade,
  locale text not null,
  version int not null,
  state text not null check (state in ('PUBLISHED', 'DRAFT_HUMAN', 'DRAFT_AI', 'APPROVED')),
  data jsonb not null default '{}'::jsonb,
  source_hashes jsonb not null default '{}'::jsonb,
  is_head_published boolean not null default false,
  is_head_draft boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  published_at timestamptz null,
  published_by text null,
  unpublished_at timestamptz null,
  unpublished_by text null,
  constraint uq_document_localized_version unique (doc_id, locale, version)
);
create unique index uq_doc_loc_head_published on document_localized (doc_id, locale) where is_head_published;
create unique index uq_doc_loc_head_draft on document_localized (doc_id, locale) where is_head_draft;
create index idx_doc_loc_lookup on document_localized (doc_id, locale, version);
create index idx_doc_loc_published_at on document_localized (doc_id, locale, published_at);

create table ai_jobs (
  id bigint generated always as identity primary key,
  doc_id uuid not null references documents (id) on delete cascade,
  locale text not null,
  field_paths text[] not null,
  source_version int not null,
  source_hashes jsonb not null default '{}'::jsonb,
  state text not null check (state in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default clock_timestamp(),
  locked_until timestamptz null,
  locked_by text null,
  cost_estimate_micros bigint not null default 0,
  budget_scope text null,
  error_message text null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create unique index uq_ai_jobs_active on ai_jobs (doc_id, locale, source_version) where state in ('QUEUED', 'RUNNING');
create index idx_ai_jobs_polling on ai_jobs (run_after, id) where state = 'QUEUED';
create index idx_ai_jobs_reaper on ai_jobs (locked_until) where state = 'RUNNING';

create table content_provenance (
  id bigint generated always as identity primary key,
  doc_id uuid not null references documents (id) on delete cascade,
  locale text not null,
  version int null,
  field_path text null,
  job_id bigint null references ai_jobs (id) on delete set null,
  model_id text not null,
  prompt_version text not null,
  prompt_tokens int not null,
  completion_tokens int not null,
  cost_micros bigint not null,
  edited boolean not null default false,
  discarded boolean not null default false,
  discard_reason text null,
  warnings text[] not null default '{}',
  acknowledged_warnings text[] null,
  bulk_id uuid null,
  approved_by text null,
  approved_at timestamptz null,
  created_at timestamptz not null default clock_timestamp()
);
create index idx_provenance_doc_ver on content_provenance (doc_id, locale, version);
create index idx_provenance_bulk on content_provenance (bulk_id) where bulk_id is not null;

create table releases (
  id bigint generated always as identity primary key,
  name text not null,
  created_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz null,
  published_by text null,
  allow_stale boolean not null default false
);

create table release_items (
  release_id bigint not null references releases (id) on delete cascade,
  doc_id uuid not null references documents (id) on delete cascade,
  locale text null,
  draft_version int not null,
  added_by text not null,
  added_at timestamptz not null default clock_timestamp()
);
create unique index uq_release_items on release_items (release_id, doc_id, coalesce(locale, ''));

create table glossary (
  id bigint generated always as identity primary key,
  source_locale text not null,
  target_locale text not null,
  term text not null,
  translation text null,
  accepted_forms text[] not null default '{}',
  do_not_translate boolean not null default false,
  note text null
);

create table ai_budgets (
  id bigint generated always as identity primary key,
  scope text not null,
  period_start date not null,
  cap_micros bigint not null,
  spent_micros bigint not null default 0,
  constraint uq_ai_budgets_scope_period unique (scope, period_start)
);
