-- =============================================================================
-- Feedback sessions: every 3 audit weeks each CAM books a feedback session with
-- the QA person who audited them most (their Team Lead joins).
--  * feedback_cycles    one row per cycle (e.g. Session 22 = WK-38, 39, 40)
--  * feedback_sessions  one row per CAM per cycle: provider, Lead, status, booking
--  * feedback_responses the feedback form answers (QA only)
-- A cycle is built automatically when its last week is published (settings
-- 'feedback': anchor cycle number + first week start date, 3 weeks per cycle),
-- or by QA from the Feedback Sessions page. Rebuilding keeps manual provider
-- changes and booking status. Safe to run more than once.
-- =============================================================================

insert into public.settings (key, value, description) values ('feedback',
  '{"booking_url": "https://qaanywhereworks.setmore.com/book?step=staff&products=04932840-f23f-4dfa-9b79-ebe915086d79&type=service",
    "anchor_number": 22, "anchor_start": "2026-09-17", "weeks_per_cycle": 3, "book_by_days": 23}'::jsonb,
  'Feedback sessions: booking link, cycle numbering (anchor) and booking deadline (days after the last week ends)')
on conflict (key) do nothing;

create table if not exists public.feedback_cycles (
  id           uuid primary key default gen_random_uuid(),
  number       int not null unique,
  period_ids   uuid[] not null,
  book_by      date,
  released_at  timestamptz,            -- set when the cycle's last week is published; CAMs and Leads see it from then
  created_at   timestamptz not null default now(),
  created_by   uuid references public.employees (id)
);

create table if not exists public.feedback_sessions (
  id             uuid primary key default gen_random_uuid(),
  cycle_id       uuid not null references public.feedback_cycles (id) on delete cascade,
  cam_id         uuid not null references public.employees (id),
  lead_id        uuid references public.employees (id),
  provider_id    uuid references public.employees (id),
  provider_name  text,
  provider_auto  boolean not null default true,
  weeks          jsonb not null default '[]'::jsonb,   -- [{period_id, label, evaluator, audits}]
  status         text not null default 'not_booked' check (status in ('not_booked', 'booked', 'completed', 'cancelled', 'no_audit')),
  booked_for     timestamptz,
  booked_at      timestamptz,
  completed_at   timestamptz,
  updated_at     timestamptz not null default now(),
  unique (cycle_id, cam_id)
);
create index if not exists feedback_sessions_cam_idx on public.feedback_sessions (cam_id);

create table if not exists public.feedback_responses (
  id                    uuid primary key default gen_random_uuid(),
  row_key               text not null unique,     -- form timestamp + email, so re-sending rows is safe
  submitted_at          timestamptz not null,
  cam_email             text not null,
  cam_id                uuid references public.employees (id),
  provider_name         text,
  lead_present          text,
  agrees                text,
  feedback_for_provider text,
  lead_name             text,
  qa_feedback           text,
  session_id            uuid references public.feedback_sessions (id) on delete set null,
  created_at            timestamptz not null default now()
);

alter table public.feedback_cycles enable row level security;
alter table public.feedback_sessions enable row level security;
alter table public.feedback_responses enable row level security;

drop policy if exists feedback_cycles_select on public.feedback_cycles;
create policy feedback_cycles_select on public.feedback_cycles for select to authenticated
  using ((select public.is_qa()) or released_at is not null);

drop policy if exists feedback_sessions_select on public.feedback_sessions;
create policy feedback_sessions_select on public.feedback_sessions for select to authenticated using (
  (select public.is_qa())
  or ((cam_id in (select public.my_visible_cam_ids()) or lead_id = (select public.my_employee_id()))
      and cycle_id in (select c.id from public.feedback_cycles c where c.released_at is not null))
);

drop policy if exists feedback_responses_select on public.feedback_responses;
create policy feedback_responses_select on public.feedback_responses for select to authenticated
  using ((select public.is_qa()));

grant select on public.feedback_cycles, public.feedback_sessions, public.feedback_responses to authenticated;

drop trigger if exists audit_feedback_sessions on public.feedback_sessions;
create trigger audit_feedback_sessions after insert or update or delete on public.feedback_sessions
  for each row execute function public.audit_row_change();

-- ---------------------------------------------------------------------------
-- Build (or refresh) a cycle. Week evaluator = who audited the CAM most that week
-- (tie: earliest audit). Provider = the evaluator of the most weeks (tie: earliest week).
-- ---------------------------------------------------------------------------
create or replace function public._build_feedback_cycle(p_number int, p_period_ids uuid[], p_book_by date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cycle uuid;
  v_last public.reporting_periods;
begin
  if coalesce(array_length(p_period_ids, 1), 0) = 0 then raise exception 'Choose the audit weeks for this cycle'; end if;
  select * into v_last from public.reporting_periods where id = any (p_period_ids) order by start_date desc limit 1;

  insert into public.feedback_cycles as c (number, period_ids, book_by, created_by, released_at)
  values (p_number, p_period_ids, p_book_by, public.my_employee_id(), case when v_last.status = 'published' then now() end)
  on conflict (number) do update
     set period_ids = excluded.period_ids,
         book_by = coalesce(excluded.book_by, c.book_by),
         released_at = coalesce(c.released_at, excluded.released_at)
  returning id into v_cycle;

  with weeks as (
    select p.id, p.short_label, p.start_date, ord
    from unnest(p_period_ids) with ordinality as u(pid, ord) join public.reporting_periods p on p.id = u.pid
  ),
  per_eval as (   -- audits per CAM, week and evaluator
    select e.cam_id, w.id as period_id, w.ord,
           lower(coalesce(nullif(e.evaluator_email, ''), e.evaluator_name)) as ev_key,
           max(e.evaluator_name) as ev_name, max(e.evaluator_id::text)::uuid as ev_id,
           count(*) as n, min(e.audited_at) as first_at
    from public.evaluations e join weeks w on w.id = e.period_id
    group by 1, 2, 3, 4
  ),
  week_top as (   -- the main evaluator of each CAM-week
    select distinct on (cam_id, period_id) cam_id, period_id, ord, ev_key, ev_name, ev_id, n
    from per_eval order by cam_id, period_id, n desc, first_at
  ),
  provider as (
    select distinct on (cam_id) cam_id, ev_key, ev_name, ev_id
    from (select cam_id, ev_key, max(ev_name) ev_name, max(ev_id::text)::uuid ev_id, count(*) weeks, min(ord) first_ord
          from week_top group by cam_id, ev_key) x
    order by cam_id, weeks desc, first_ord
  ),
  cams as (       -- everyone audited in the cycle, plus active CAMs with no audit
    select distinct cam_id from per_eval
    union
    select id from public.employees where role = 'user' and status = 'active' and not is_demo
  ),
  cam_rows as (
    select c.cam_id,
           t.lead_id,
           coalesce(pe.id, pv.ev_id) as provider_id,
           coalesce(pe.full_name, pv.ev_name) as provider_name,
           pv.cam_id is not null as audited,
           (select coalesce(jsonb_agg(jsonb_build_object('period_id', w.id, 'label', w.short_label,
                      'evaluator', coalesce(we.full_name, wt.ev_name), 'audits', coalesce(wt.n, 0)) order by w.ord), '[]'::jsonb)
              from weeks w
              left join week_top wt on wt.cam_id = c.cam_id and wt.period_id = w.id
              left join public.employees we on we.email = wt.ev_key) as weeks
    from cams c
    join public.employees emp on emp.id = c.cam_id and emp.status = 'active'
    left join public.teams t on t.id = emp.team_id
    left join provider pv on pv.cam_id = c.cam_id
    left join public.employees pe on pe.email = pv.ev_key
  )
  insert into public.feedback_sessions as s (cycle_id, cam_id, lead_id, provider_id, provider_name, weeks, status)
  select v_cycle, r.cam_id, r.lead_id, r.provider_id, r.provider_name, r.weeks, case when r.audited then 'not_booked' else 'no_audit' end
  from cam_rows r
  on conflict (cycle_id, cam_id) do update
     set lead_id = excluded.lead_id,
         weeks = excluded.weeks,
         provider_id = case when s.provider_auto then excluded.provider_id else s.provider_id end,
         provider_name = case when s.provider_auto then excluded.provider_name else s.provider_name end,
         status = case when s.status in ('not_booked', 'no_audit') then excluded.status else s.status end,
         updated_at = now();
  return v_cycle;
end $$;
revoke execute on function public._build_feedback_cycle(int, uuid[], date) from public, anon, authenticated;

create or replace function public.build_feedback_cycle(p_number int, p_period_ids uuid[], p_book_by date default null)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not public.is_qa() then raise exception 'Only QA can set up feedback sessions' using errcode = '42501'; end if;
  return public._build_feedback_cycle(p_number, p_period_ids, p_book_by);
end $$;
revoke execute on function public.build_feedback_cycle(int, uuid[], date) from public, anon;
grant execute on function public.build_feedback_cycle(int, uuid[], date) to authenticated;

-- When a week is published: release any cycle it ends, or build the cycle it completes.
create or replace function public.on_period_published_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := coalesce(public.get_setting('feedback'), '{}'::jsonb);
  k int; per int := greatest(coalesce((cfg ->> 'weeks_per_cycle')::int, 3), 1);
  v_ids uuid[];
begin
  if new.status <> 'published' or old.status = 'published' or new.is_demo then return new; end if;
  update public.feedback_cycles set released_at = now()
   where released_at is null and new.id = any (period_ids)
     and new.id = (select p.id from public.reporting_periods p where p.id = any (period_ids) order by p.start_date desc limit 1);
  if found or nullif(cfg ->> 'anchor_start', '') is null then return new; end if;
  k := (new.start_date - (cfg ->> 'anchor_start')::date) / 7;
  if k < 0 or k % per <> per - 1 then return new; end if;
  select array_agg(p.id order by p.start_date) into v_ids from public.reporting_periods p
   where p.start_date between new.start_date - 7 * (per - 1) and new.start_date and not p.is_demo;
  perform public._build_feedback_cycle((cfg ->> 'anchor_number')::int + k / per, v_ids,
          new.end_date + coalesce((cfg ->> 'book_by_days')::int, 23));
  return new;
end $$;
drop trigger if exists period_published_feedback on public.reporting_periods;
create trigger period_published_feedback after update of status on public.reporting_periods
  for each row execute function public.on_period_published_feedback();

-- ---------------------------------------------------------------------------
-- CAM: record the booking made in Setmore (or a new time when rescheduling).
-- ---------------------------------------------------------------------------
create or replace function public.mark_feedback_booked(p_session uuid, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare s public.feedback_sessions;
begin
  select * into s from public.feedback_sessions where id = p_session;
  if s.id is null then raise exception 'Feedback session not found'; end if;
  if s.cam_id is distinct from public.my_employee_id() and not public.is_qa() then
    raise exception 'Only the CAM (or QA) can record this booking' using errcode = '42501';
  end if;
  if s.status = 'completed' then raise exception 'This feedback session is already completed'; end if;
  if p_when is null then raise exception 'Enter the date and time you booked'; end if;
  update public.feedback_sessions set status = 'booked', booked_for = p_when, booked_at = now(), updated_at = now() where id = p_session;
end $$;
revoke execute on function public.mark_feedback_booked(uuid, timestamptz) from public, anon;
grant execute on function public.mark_feedback_booked(uuid, timestamptz) to authenticated;

-- QA: change the provider or the status of a session.
create or replace function public.update_feedback_session(p_session uuid, p_provider uuid default null, p_status text default null)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.employees;
begin
  if not public.is_qa() then raise exception 'Only QA can change feedback sessions' using errcode = '42501'; end if;
  if p_provider is not null then
    select * into pr from public.employees where id = p_provider and status = 'active' and role in ('super_admin', 'evaluator');
    if pr.id is null then raise exception 'Choose an active QA team member as the provider'; end if;
    update public.feedback_sessions set provider_id = pr.id, provider_name = pr.full_name, provider_auto = false,
           status = case when status = 'no_audit' then 'not_booked' else status end, updated_at = now() where id = p_session;
  end if;
  if p_status is not null then
    if p_status not in ('not_booked', 'booked', 'completed', 'cancelled', 'no_audit') then raise exception 'Unknown status'; end if;
    update public.feedback_sessions set status = p_status, updated_at = now(),
           completed_at = case when p_status = 'completed' then coalesce(completed_at, now()) else null end where id = p_session;
  end if;
end $$;
revoke execute on function public.update_feedback_session(uuid, uuid, text) from public, anon;
grant execute on function public.update_feedback_session(uuid, uuid, text) to authenticated;

-- QA: change a cycle's booking deadline.
create or replace function public.update_feedback_cycle(p_cycle uuid, p_book_by date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_qa() then raise exception 'Only QA can change feedback cycles' using errcode = '42501'; end if;
  update public.feedback_cycles set book_by = p_book_by where id = p_cycle;
end $$;
revoke execute on function public.update_feedback_cycle(uuid, date) from public, anon;
grant execute on function public.update_feedback_cycle(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Sheet script (service role): store form responses; a response marks the CAM's
-- earliest open session (from a cycle that existed then) as completed.
-- p_rows: [{submitted_at, email, provider, lead_present, agrees, feedback, lead_name, qa_feedback}]
-- ---------------------------------------------------------------------------
create or replace function public.ingest_feedback_responses(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_id uuid; v_new boolean; v_cam uuid; v_sess uuid; n_new int := 0; n_done int := 0; v_at timestamptz;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin v_at := (r ->> 'submitted_at')::timestamptz; exception when others then continue; end;
    if v_at is null or coalesce(r ->> 'email', '') = '' then continue; end if;
    select id into v_cam from public.employees where email = lower(trim(r ->> 'email'));
    insert into public.feedback_responses (row_key, submitted_at, cam_email, cam_id, provider_name, lead_present, agrees,
                                           feedback_for_provider, lead_name, qa_feedback)
    values (to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '|' || lower(trim(r ->> 'email')), v_at, lower(trim(r ->> 'email')), v_cam,
            nullif(r ->> 'provider', ''), nullif(r ->> 'lead_present', ''), nullif(r ->> 'agrees', ''),
            nullif(r ->> 'feedback', ''), nullif(r ->> 'lead_name', ''), nullif(r ->> 'qa_feedback', ''))
    on conflict (row_key) do update
       set cam_id = excluded.cam_id, provider_name = excluded.provider_name, lead_present = excluded.lead_present,
           agrees = excluded.agrees, feedback_for_provider = excluded.feedback_for_provider,
           lead_name = excluded.lead_name, qa_feedback = excluded.qa_feedback
    returning id, (xmax = 0) into v_id, v_new;
    if not v_new then v_id := null; continue; end if;   -- already stored: answers refreshed (e.g. QA Feedback added later)
    n_new := n_new + 1;
    if v_cam is not null then
      select s.id into v_sess from public.feedback_sessions s join public.feedback_cycles c on c.id = s.cycle_id
       where s.cam_id = v_cam and s.status in ('not_booked', 'booked') and c.created_at <= v_at
       order by c.number limit 1;
      if v_sess is not null then
        update public.feedback_sessions set status = 'completed', completed_at = v_at, updated_at = now() where id = v_sess;
        update public.feedback_responses set session_id = v_sess where id = v_id;
        n_done := n_done + 1;
      end if;
    end if;
    v_id := null; v_sess := null;
  end loop;
  return jsonb_build_object('new', n_new, 'completed', n_done);
end $$;
revoke execute on function public.ingest_feedback_responses(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_feedback_responses(jsonb) to service_role;

-- Sheet script (service role): the latest released cycles, laid out for the Feedback Sessions sheet.
create or replace function public.feedback_sheet_feed()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'number')::int desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'number', c.number, 'book_by', c.book_by, 'booking_url', public.get_setting('feedback') ->> 'booking_url',
      'weeks', (select jsonb_agg(p.short_label order by p.start_date) from public.reporting_periods p where p.id = any (c.period_ids)),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                  'cam_email', cam.email, 'cam_name', cam.full_name, 'lead_name', ld.full_name,
                  'provider', split_part(coalesce(s.provider_name, ''), ' ', 1), 'provider_full', s.provider_name,
                  'weeks', (select jsonb_agg(case when (w ->> 'audits')::int > 0 then split_part(w ->> 'evaluator', ' ', 1) else 'No Audit' end)
                              from jsonb_array_elements(s.weeks) w),
                  'status', s.status, 'booked_for', s.booked_for) order by cam.full_name), '[]'::jsonb)
               from public.feedback_sessions s join public.employees cam on cam.id = s.cam_id
               left join public.employees ld on ld.id = s.lead_id
               where s.cycle_id = c.id)) as x
    from public.feedback_cycles c where c.released_at is not null
    order by c.number desc limit 2
  ) t
$$;
revoke execute on function public.feedback_sheet_feed() from public, anon, authenticated;
grant execute on function public.feedback_sheet_feed() to service_role;

-- Sessions with names, for the Feedback Sessions page (same visibility as the table policy).
create or replace function public.list_feedback_sessions(p_cycle uuid default null)
returns table (id uuid, cycle_id uuid, cycle_number int, book_by date, cam_id uuid, cam_name text, cam_email text,
               lead_id uuid, lead_name text, provider_id uuid, provider_name text, provider_auto boolean, weeks jsonb,
               status text, booked_for timestamptz, booked_at timestamptz, completed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.cycle_id, c.number, c.book_by, s.cam_id, cam.full_name, cam.email, s.lead_id, ld.full_name,
         s.provider_id, s.provider_name, s.provider_auto, s.weeks, s.status, s.booked_for, s.booked_at, s.completed_at
  from public.feedback_sessions s
  join public.feedback_cycles c on c.id = s.cycle_id
  join public.employees cam on cam.id = s.cam_id
  left join public.employees ld on ld.id = s.lead_id
  where (p_cycle is null or s.cycle_id = p_cycle)
    and (public.is_qa()
         or (c.released_at is not null
             and (s.cam_id in (select public.my_visible_cam_ids()) or s.lead_id = public.my_employee_id())))
  order by c.number desc, cam.full_name
$$;
revoke execute on function public.list_feedback_sessions(uuid) from public, anon;
grant execute on function public.list_feedback_sessions(uuid) to authenticated;

-- After new audits arrive: refresh cycles whose booking window is still open (keeps manual changes).
create or replace function public.refresh_open_feedback_cycles()
returns int language plpgsql security definer set search_path = public as $$
declare c record; n int := 0;
begin
  for c in select * from public.feedback_cycles where released_at is not null and (book_by is null or book_by >= current_date) loop
    perform public._build_feedback_cycle(c.number, c.period_ids, c.book_by); n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.refresh_open_feedback_cycles() from public, anon, authenticated;
grant execute on function public.refresh_open_feedback_cycles() to service_role;
