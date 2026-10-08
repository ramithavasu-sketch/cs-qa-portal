-- =============================================================================
-- Fixed appeal closing date per audit week.
-- When reporting_periods.appeal_closes_at is set, appeals for that week close
-- exactly then; otherwise the configured rule applies (appeal_window days after
-- publication). Every submission path (submit_appeal, submit_draft_appeal) uses
-- appeal_deadline(), so the date is enforced in the database.
-- Safe to run more than once.
-- =============================================================================
alter table public.reporting_periods add column if not exists appeal_closes_at timestamptz;
comment on column public.reporting_periods.appeal_closes_at is 'Optional fixed appeal deadline for this week (overrides the appeal_window rule)';

create or replace function public.appeal_deadline(p_evaluation uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
           rp.appeal_closes_at,
           public.add_days_setting(
             rp.published_at,
             coalesce((public.get_setting('appeal_window') ->> 'days')::int, 5),
             coalesce((public.get_setting('appeal_window') ->> 'business_days')::boolean, true)))
  from public.evaluations e
  join public.reporting_periods rp on rp.id = e.period_id
  where e.id = p_evaluation and rp.status = 'published'
$$;
