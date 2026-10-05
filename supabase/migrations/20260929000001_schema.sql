-- =============================================================================
-- CS QA Performance Portal — core schema
-- Target: Supabase (PostgreSQL 15+). All access is governed by RLS (see 0003).
-- Original evaluation data is immutable; appeal / QA changes are stored as
-- score_adjustments and applied through the *_effective views.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('super_admin', 'admin', 'user');
create type public.employee_status as enum ('active', 'inactive');
create type public.period_status as enum ('draft', 'published');
create type public.appeal_status as enum (
  'draft', 'pending_lead_review', 'returned_to_cam', 'pending_qa_review',
  'pending_additional_info', 'approved', 'partially_approved', 'rejected', 'closed'
);
create type public.item_decision as enum ('pending', 'approved', 'rejected');
create type public.lead_recommendation as enum ('recommend_approval', 'recommend_rejection', 'request_more_info');
create type public.comment_visibility as enum ('shared', 'internal');

-- ---------------------------------------------------------------------------
-- People & teams
-- ---------------------------------------------------------------------------
-- employees exists independently of auth.users so that audit data can be
-- imported for CAMs before they have been invited. auth_user_id links a login.
create table public.employees (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  email         text not null,
  full_name     text not null,
  role          public.app_role not null default 'user',
  status        public.employee_status not null default 'active',
  team_id       uuid,
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint employees_email_lower check (email = lower(email))
);
create unique index employees_email_uidx on public.employees (email);

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  lead_id     uuid references public.employees (id) on delete set null,
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.employees
  add constraint employees_team_fk foreign key (team_id) references public.teams (id) on delete set null;
create index employees_team_idx on public.employees (team_id);
create index teams_lead_idx on public.teams (lead_id);

-- ---------------------------------------------------------------------------
-- Scoring framework (configurable by Super Admin)
-- ---------------------------------------------------------------------------
create table public.task_types (
  code             text primary key,               -- ER, CHAT, IB_CALL, INTERNAL
  name             text not null,
  source_label     text not null unique,           -- value in the audit form "Task Type" column
  feedback_column  text,                            -- e.g. 'Feedback (ER)'
  fcr_column       text,                            -- e.g. ' [First Contact Resolution (ER)]'
  sort_order       int not null default 0,
  active           boolean not null default true
);

create table public.evaluation_parameters (
  id             uuid primary key default gen_random_uuid(),
  task_type      text not null references public.task_types (code),
  name           text not null,
  section        text,                              -- 'Soft Skills' / 'Technical Skills' (IB calls)
  max_score      numeric(6,2) not null check (max_score > 0),
  sort_order     int not null default 0,
  source_column  text,                              -- audit form column header
  active         boolean not null default true,
  unique (task_type, name)
);
create index evaluation_parameters_type_idx on public.evaluation_parameters (task_type);

create table public.settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.employees (id)
);

-- ---------------------------------------------------------------------------
-- Reporting periods (audit weeks)
-- ---------------------------------------------------------------------------
create table public.reporting_periods (
  id               uuid primary key default gen_random_uuid(),
  label            text not null unique,            -- e.g. 'WK-39 : 2026 (09/24- 09/30)'
  short_label      text not null,                   -- e.g. 'WK-39'
  year             int not null,
  week_number      int not null,
  start_date       date not null,
  end_date         date not null,
  status           public.period_status not null default 'draft',
  published_at     timestamptz,
  published_by     uuid references public.employees (id),
  auto_publish_at  timestamptz,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  check (end_date >= start_date)
);
create index reporting_periods_dates_idx on public.reporting_periods (start_date, end_date);

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------
create table public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('csv', 'xlsx', 'google_sheets', 'seed')),
  file_name    text,
  uploaded_by  uuid references public.employees (id),
  total_rows   int not null default 0,
  inserted     int not null default 0,
  duplicates   int not null default 0,
  rejected     int not null default 0,
  created_at   timestamptz not null default now()
);

create table public.import_rejections (
  id          bigserial primary key,
  batch_id    uuid not null references public.import_batches (id) on delete cascade,
  row_number  int not null,
  reason      text not null,
  raw         jsonb
);
create index import_rejections_batch_idx on public.import_rejections (batch_id);

-- ---------------------------------------------------------------------------
-- Evaluations (original, immutable)
-- ---------------------------------------------------------------------------
create table public.evaluations (
  id                  uuid primary key default gen_random_uuid(),
  task_id             text not null,                 -- DS task UUID parsed from the link
  task_link           text not null,
  cam_id              uuid not null references public.employees (id),
  evaluator_id        uuid references public.employees (id),
  evaluator_email     text,
  evaluator_name      text,
  task_type           text not null references public.task_types (code),
  request_from        text,                          -- Client / Agent
  task_loaded_date    date,
  audited_at          timestamptz not null,          -- form timestamp
  period_id           uuid not null references public.reporting_periods (id),
  task_seq            text,                          -- 'Task 3'
  connection_id       text,
  screenshot_url      text,
  autofail            boolean not null default false,
  fcr                 text check (fcr in ('Yes', 'No')),
  original_score      numeric(6,2) not null,         -- score as recorded by QA (0-100)
  feedback            text,
  lead_name_at_audit  text,
  import_batch_id     uuid references public.import_batches (id),
  is_demo             boolean not null default false,
  created_at          timestamptz not null default now(),
  constraint evaluations_unique_audit unique (task_link, cam_id, period_id)
);
create index evaluations_cam_period_idx on public.evaluations (cam_id, period_id);
create index evaluations_period_idx on public.evaluations (period_id);
create index evaluations_type_idx on public.evaluations (task_type);

create table public.evaluation_scores (
  id             uuid primary key default gen_random_uuid(),
  evaluation_id  uuid not null references public.evaluations (id) on delete cascade,
  parameter_id   uuid not null references public.evaluation_parameters (id),
  earned         numeric(6,2),                       -- null = Not Applicable
  max_score      numeric(6,2) not null,              -- snapshot of rubric max at audit time
  remarks        text,
  unique (evaluation_id, parameter_id),
  check (earned is null or (earned >= 0 and earned <= max_score))
);
create index evaluation_scores_eval_idx on public.evaluation_scores (evaluation_id);
create index evaluation_scores_param_idx on public.evaluation_scores (parameter_id);

-- ---------------------------------------------------------------------------
-- Appeals
-- ---------------------------------------------------------------------------
create sequence public.appeal_ref_seq start 1001;

create table public.appeals (
  id                   uuid primary key default gen_random_uuid(),
  reference            text not null unique,
  evaluation_id        uuid not null references public.evaluations (id),
  cam_id               uuid not null references public.employees (id),
  lead_id              uuid references public.employees (id),   -- routed Team Lead
  status               public.appeal_status not null default 'draft',
  reason               text not null,
  info_requested_from  text check (info_requested_from in ('cam', 'lead')),
  info_due_at          timestamptz,
  lead_recommendation  public.lead_recommendation,
  submitted_at         timestamptz,
  forwarded_at         timestamptz,
  decided_at           timestamptz,
  decided_by           uuid references public.employees (id),
  resolution_note      text,
  status_changed_at    timestamptz not null default now(),
  is_demo              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index appeals_cam_idx on public.appeals (cam_id);
create index appeals_lead_idx on public.appeals (lead_id);
create index appeals_status_idx on public.appeals (status);
create index appeals_eval_idx on public.appeals (evaluation_id);

create table public.appeal_items (
  id               uuid primary key default gen_random_uuid(),
  appeal_id        uuid not null references public.appeals (id) on delete cascade,
  parameter_id     uuid references public.evaluation_parameters (id),  -- null when is_autofail
  is_autofail      boolean not null default false,
  original_score   numeric(6,2),
  requested_score  numeric(6,2),
  decision         public.item_decision not null default 'pending',
  revised_score    numeric(6,2),
  decision_reason  text,
  decided_by       uuid references public.employees (id),
  decided_at       timestamptz,
  check ((is_autofail and parameter_id is null) or (not is_autofail and parameter_id is not null))
);
create index appeal_items_appeal_idx on public.appeal_items (appeal_id);

-- Timeline: every action and every comment (Lead internal comments are 'internal').
create table public.appeal_events (
  id              uuid primary key default gen_random_uuid(),
  appeal_id       uuid not null references public.appeals (id) on delete cascade,
  actor_id        uuid references public.employees (id),
  actor_role      public.app_role,
  action          text not null,   -- submitted, lead_forwarded, lead_returned, cam_responded, lead_responded,
                                   -- qa_requested_info, qa_decided, qa_reopened, closed, comment
  recommendation  public.lead_recommendation,
  comment         text,
  visibility      public.comment_visibility not null default 'shared',
  from_status     public.appeal_status,
  to_status       public.appeal_status,
  created_at      timestamptz not null default now()
);
create index appeal_events_appeal_idx on public.appeal_events (appeal_id, created_at);

create table public.appeal_evidence (
  id            uuid primary key default gen_random_uuid(),
  appeal_id     uuid not null references public.appeals (id) on delete cascade,
  storage_path  text not null unique,              -- '<appeal_id>/<uuid>-<file>'
  file_name     text not null,
  mime_type     text not null,
  size_bytes    int not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by   uuid not null references public.employees (id),
  created_at    timestamptz not null default now()
);
create index appeal_evidence_appeal_idx on public.appeal_evidence (appeal_id);

-- QA can permit a new appeal on a task/parameter that was already decided.
create table public.appeal_resubmission_grants (
  id             uuid primary key default gen_random_uuid(),
  evaluation_id  uuid not null references public.evaluations (id),
  parameter_id   uuid references public.evaluation_parameters (id),
  is_autofail    boolean not null default false,
  granted_by     uuid not null references public.employees (id),
  reason         text not null,
  used_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Score adjustments (append-only; latest per evaluation+parameter wins)
-- ---------------------------------------------------------------------------
create table public.score_adjustments (
  id              uuid primary key default gen_random_uuid(),
  evaluation_id   uuid not null references public.evaluations (id),
  kind            text not null check (kind in ('parameter', 'autofail')),
  parameter_id    uuid references public.evaluation_parameters (id),
  original_value  numeric(6,2) not null,   -- value before this adjustment (for autofail: 1/0)
  revised_value   numeric(6,2) not null,
  reason          text not null check (length(trim(reason)) >= 5),
  appeal_id       uuid references public.appeals (id),
  appeal_item_id  uuid references public.appeal_items (id),
  approved_by     uuid not null references public.employees (id),
  created_at      timestamptz not null default clock_timestamp(),
  check ((kind = 'parameter' and parameter_id is not null) or (kind = 'autofail' and parameter_id is null))
);
create index score_adjustments_eval_idx on public.score_adjustments (evaluation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Notifications, email outbox, audit log
-- ---------------------------------------------------------------------------
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.employees (id) on delete cascade,
  type          text not null,
  title         text not null,
  message       text not null,
  link          text,
  appeal_id     uuid references public.appeals (id) on delete cascade,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

-- Emails are queued here and sent by the `send-email` Edge Function.
-- Bodies intentionally contain only reference, task id, status and a portal link.
create table public.email_outbox (
  id               uuid primary key default gen_random_uuid(),
  recipient_email  text not null,
  subject          text not null,
  body_text        text not null,
  status           text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts         int not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index email_outbox_status_idx on public.email_outbox (status, created_at);

create table public.audit_logs (
  id           bigserial primary key,
  actor_id     uuid references public.employees (id),
  action       text not null,
  table_name   text,
  record_id    text,
  previous     jsonb,
  new_value    jsonb,
  reason       text,
  created_at   timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_record_idx on public.audit_logs (table_name, record_id);
