-- =============================================================================
-- Appeal window can close at 11:59 pm (portal time zone) on its last day.
-- appeal_window.end_of_day = true: deadline = 23:59:59 on the date reached by
-- counting the configured days from publication, in reporting.timezone.
-- A per-week fixed date (reporting_periods.appeal_closes_at) still wins.
-- Also sets the QA team's rule: 7 calendar days, closing at 11:59 pm.
-- Safe to run more than once.
-- =============================================================================
create or replace function public.appeal_deadline(p_evaluation uuid)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  w jsonb := coalesce(public.get_setting('appeal_window'), '{}'::jsonb);
  tz text := coalesce(nullif(public.get_setting('reporting') ->> 'timezone', ''), 'UTC');
  rp public.reporting_periods;
  d timestamptz;
begin
  select p.* into rp from public.evaluations e join public.reporting_periods p on p.id = e.period_id
   where e.id = p_evaluation and p.status = 'published';
  if rp.id is null then return null; end if;
  if rp.appeal_closes_at is not null then return rp.appeal_closes_at; end if;
  d := public.add_days_setting(rp.published_at, coalesce((w ->> 'days')::int, 5), coalesce((w ->> 'business_days')::boolean, true));
  if coalesce((w ->> 'end_of_day')::boolean, false) then
    d := ((d at time zone tz)::date + time '23:59:59') at time zone tz;
  end if;
  return d;
end $$;

update public.settings
   set value = value || '{"days": 7, "business_days": false, "end_of_day": true}'::jsonb
 where key = 'appeal_window';
