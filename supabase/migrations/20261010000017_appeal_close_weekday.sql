-- =============================================================================
-- Appeals close on a fixed weekday: appeal_window.close_dow (1 = Monday … 7 = Sunday).
-- When set, a week's appeals close at 23:59:59 (portal time zone) on the first
-- such weekday after the day it was published, e.g. published Thursday 11:59 pm
-- → closes the following Wednesday 11:59 pm. A per-week fixed date
-- (reporting_periods.appeal_closes_at) still wins.
-- QA team rule: publish Thursday 11:59 pm, appeals close Wednesday 11:59 pm.
-- Safe to run more than once.
-- =============================================================================
create or replace function public.appeal_deadline(p_evaluation uuid)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  w jsonb := coalesce(public.get_setting('appeal_window'), '{}'::jsonb);
  tz text := coalesce(nullif(public.get_setting('reporting') ->> 'timezone', ''), 'UTC');
  dow int := nullif(w ->> 'close_dow', '')::int;
  rp public.reporting_periods;
  d timestamptz;
  pub date;
begin
  select p.* into rp from public.evaluations e join public.reporting_periods p on p.id = e.period_id
   where e.id = p_evaluation and p.status = 'published';
  if rp.id is null then return null; end if;
  if rp.appeal_closes_at is not null then return rp.appeal_closes_at; end if;
  if dow between 1 and 7 then
    pub := (rp.published_at at time zone tz)::date;
    return ((pub + ((dow - extract(isodow from pub)::int + 6) % 7 + 1)) + time '23:59:59') at time zone tz;
  end if;
  d := public.add_days_setting(rp.published_at, coalesce((w ->> 'days')::int, 5), coalesce((w ->> 'business_days')::boolean, true));
  if coalesce((w ->> 'end_of_day')::boolean, false) then
    d := ((d at time zone tz)::date + time '23:59:59') at time zone tz;
  end if;
  return d;
end $$;

update public.settings
   set value = value || '{"close_dow": 3, "days": 6, "business_days": false, "end_of_day": true}'::jsonb
 where key = 'appeal_window';
