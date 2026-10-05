-- =============================================================================
-- Weekly report emails to CAMs (To: CAM, CC: Team Lead) + CAM ↔ Lead mapping import.
-- Emails are rendered server-side from the `report_email` setting, queued in
-- email_outbox and delivered by the `send-email` Edge Function.
-- The email only carries a portal link (never scores or feedback).
-- =============================================================================

alter table public.email_outbox
  add column if not exists cc_email text,
  add column if not exists reply_to text,
  add column if not exists body_html text,
  add column if not exists kind text not null default 'notification' check (kind in ('notification', 'weekly_report'));

create table public.weekly_report_emails (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references public.reporting_periods (id) on delete cascade,
  cam_id      uuid not null references public.employees (id) on delete cascade,
  outbox_id   uuid not null references public.email_outbox (id) on delete cascade,
  to_email    text not null,
  cc_email    text,
  queued_by   uuid references public.employees (id),
  queued_at   timestamptz not null default now()
);
create index weekly_report_emails_period_idx on public.weekly_report_emails (period_id, cam_id, queued_at desc);
alter table public.weekly_report_emails enable row level security;
create policy weekly_report_emails_select on public.weekly_report_emails for select to authenticated using (public.is_super_admin());
revoke all on public.weekly_report_emails from anon, authenticated;
grant select on public.weekly_report_emails to authenticated;

create or replace function public._html_escape(p text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
$$;

-- Lists every CAM audited in the week with recipients and last send status.
create or replace function public.weekly_email_preview(p_period uuid)
returns table (cam_id uuid, cam_name text, cam_email text, cam_active boolean, lead_name text, lead_email text,
               tasks int, last_status text, last_sent_at timestamptz, last_error text, last_queued_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only QA can send weekly report emails' using errcode = '42501'; end if;
  return query
  select c.id, c.full_name, c.email, c.status = 'active', l.full_name, l.email,
         count(e.id)::int,
         w.status, w.sent_at, w.last_error, w.queued_at
  from public.evaluations e
  join public.employees c on c.id = e.cam_id
  left join public.teams t on t.id = c.team_id
  left join public.employees l on l.id = t.lead_id
  left join lateral (
    select o.status, o.sent_at, o.last_error, wr.queued_at
    from public.weekly_report_emails wr join public.email_outbox o on o.id = wr.outbox_id
    where wr.period_id = p_period and wr.cam_id = c.id
    order by wr.queued_at desc limit 1
  ) w on true
  where e.period_id = p_period
  group by c.id, c.full_name, c.email, c.status, l.full_name, l.email, w.status, w.sent_at, w.last_error, w.queued_at
  order by c.full_name;
end $$;

-- Queues one email per CAM. p_cam_ids null = everyone audited that week.
-- Without p_resend, CAMs whose email for this week is already queued or sent are skipped.
create or replace function public.queue_weekly_report_emails(p_period uuid, p_cam_ids uuid[] default null, p_resend boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := public.my_employee_id();
  p public.reporting_periods;
  cfg jsonb := coalesce(public.get_setting('report_email'), '{}'::jsonb);
  portal text := coalesce(public.get_setting('notifications') ->> 'portal_url', '');
  r record;
  v_subject text; v_html text; v_text text; v_link text; v_range text; v_cc text; v_out uuid;
  n_queued int := 0; n_skipped int := 0; n_no_email int := 0;
begin
  if not (public.is_super_admin() or public.is_service_role() or session_user = 'postgres') then
    raise exception 'Only QA can send weekly report emails' using errcode = '42501';
  end if;
  select * into p from public.reporting_periods where id = p_period;
  if p.id is null then raise exception 'Audit week not found'; end if;
  if p.status <> 'published' then raise exception 'Publish % before emailing CAMs — the report link would show nothing yet', p.short_label; end if;
  if portal = '' then raise exception 'Set the portal URL (Reporting & Settings → Notifications) so the email can link to the report'; end if;

  v_range := to_char(p.start_date, 'MM/DD') || '–' || to_char(p.end_date, 'MM/DD/YYYY');
  v_link := rtrim(portal, '/') || '/#/?mode=week&period=' || p.id;

  for r in
    select c.id, c.full_name, c.email, c.status, l.email as lead_email
    from public.employees c
    left join public.teams t on t.id = c.team_id
    left join public.employees l on l.id = t.lead_id and l.status = 'active'
    where c.id in (select distinct e.cam_id from public.evaluations e where e.period_id = p_period)
      and (p_cam_ids is null or c.id = any (p_cam_ids))
  loop
    if r.status <> 'active' or coalesce(r.email, '') = '' then n_no_email := n_no_email + 1; continue; end if;
    if not p_resend and exists (
      select 1 from public.weekly_report_emails wr join public.email_outbox o on o.id = wr.outbox_id
      where wr.period_id = p_period and wr.cam_id = r.id and o.status in ('queued', 'sent')) then
      n_skipped := n_skipped + 1; continue;
    end if;
    v_subject := replace(replace(replace(coalesce(cfg ->> 'subject', 'CS QA Report {WEEK} | {CAM_NAME}'),
                  '{WEEK}', p.short_label), '{CAM_NAME}', r.full_name), '{CAM_FIRST_NAME}', split_part(r.full_name, ' ', 1));
    v_html := coalesce(cfg ->> 'body_html', '<p>Hello {CAM_NAME},</p><p><a href="{REPORT_LINK}">Quality Assurance Report</a></p>');
    v_html := replace(v_html, '{CAM_NAME}', public._html_escape(r.full_name));
    v_html := replace(v_html, '{CAM_FIRST_NAME}', public._html_escape(split_part(r.full_name, ' ', 1)));
    v_html := replace(v_html, '{WEEK}', public._html_escape(p.short_label));
    v_html := replace(v_html, '{WEEK_RANGE}', public._html_escape(v_range));
    v_html := replace(v_html, '{REPORT_LINK}', public._html_escape(v_link));
    v_html := replace(v_html, '{SENDER_NAME}', public._html_escape(coalesce(cfg ->> 'sender_name', 'CS QA Team')));
    v_text := regexp_replace(regexp_replace(replace(replace(v_html, '<br>', E'\n'), '</p>', E'\n\n'), '<a href="([^"]+)">([^<]+)</a>', '\2 (\1)', 'g'), '<[^>]+>', '', 'g');
    v_text := replace(replace(replace(v_text, '&amp;', '&'), '&lt;', '<'), '&gt;', '>');
    v_cc := nullif(concat_ws(', ',
              case when coalesce((cfg ->> 'cc_lead')::boolean, true) then r.lead_email end,
              nullif(trim(coalesce(cfg ->> 'extra_cc', '')), '')), '');
    insert into public.email_outbox (recipient_email, cc_email, reply_to, subject, body_text, body_html, kind)
    values (r.email, v_cc, nullif(cfg ->> 'reply_to', ''), v_subject, v_text, v_html, 'weekly_report')
    returning id into v_out;
    insert into public.weekly_report_emails (period_id, cam_id, outbox_id, to_email, cc_email, queued_by)
    values (p_period, r.id, v_out, r.email, v_cc, v_actor);
    n_queued := n_queued + 1;
  end loop;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_value)
  values (v_actor, 'weekly_emails_queued', 'reporting_periods', p_period::text,
          jsonb_build_object('week', p.short_label, 'queued', n_queued, 'skipped_already_sent', n_skipped, 'no_email', n_no_email));
  return jsonb_build_object('queued', n_queued, 'skipped', n_skipped, 'no_email', n_no_email);
end $$;

-- Optional: queue automatically when a week is published (report_email.send_on_publish).
create or replace function public.on_period_published_emails()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'published' and old.status is distinct from 'published'
     and coalesce((public.get_setting('report_email') ->> 'send_on_publish')::boolean, false)
     and coalesce(public.get_setting('notifications') ->> 'portal_url', '') <> '' then
    begin
      perform public.queue_weekly_report_emails(new.id, null, false);
    exception when others then
      -- never block publishing; QA can send from the Weekly Report Emails page
      insert into public.audit_logs (action, table_name, record_id, reason)
      values ('weekly_emails_failed', 'reporting_periods', new.id::text, sqlerrm);
    end;
  end if;
  return new;
end $$;
create trigger reporting_periods_publish_emails after update on public.reporting_periods
  for each row execute function public.on_period_published_emails();

-- ---------------------------------------------------------------------------
-- CAM ↔ Team Lead mapping import.
-- p_rows: [{ "cam_email", "cam_name"?, "lead_email", "lead_name"?, "team"? }]
-- Creates/updates Leads (role admin), teams (one per Lead unless named) and CAM assignments.
-- ---------------------------------------------------------------------------
create or replace function public.import_team_mapping(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_lead uuid; v_team uuid; v_cam uuid; v_team_name text;
  n_leads int := 0; n_teams int := 0; n_cams int := 0; n_moved int := 0; n_rej int := 0;
  errors jsonb := '[]'::jsonb; i int := 0;
begin
  if not public.is_super_admin() then raise exception 'Only QA Super Admins can import the team mapping' using errcode = '42501'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    i := i + 1;
    if coalesce(r ->> 'cam_email', '') !~ '^[^@\s]+@[^@\s]+$' or coalesce(r ->> 'lead_email', '') !~ '^[^@\s]+@[^@\s]+$' then
      n_rej := n_rej + 1; errors := errors || jsonb_build_object('row', i, 'reason', 'CAM email and Lead email are required'); continue;
    end if;
    -- Lead
    select id into v_lead from public.employees where email = lower(trim(r ->> 'lead_email'));
    if v_lead is null then
      insert into public.employees (email, full_name, role)
      values (lower(trim(r ->> 'lead_email')), coalesce(nullif(trim(r ->> 'lead_name'), ''), split_part(r ->> 'lead_email', '@', 1)), 'admin')
      returning id into v_lead;
      n_leads := n_leads + 1;
    else
      update public.employees set role = 'admin'
       where id = v_lead and role = 'user';
    end if;
    -- Team
    v_team_name := coalesce(nullif(trim(r ->> 'team'), ''), 'Team ' || (select full_name from public.employees where id = v_lead));
    select id into v_team from public.teams where lower(name) = lower(v_team_name);
    if v_team is null then
      insert into public.teams (name, lead_id) values (v_team_name, v_lead) returning id into v_team;
      n_teams := n_teams + 1;
    elsif (select lead_id from public.teams where id = v_team) is distinct from v_lead then
      update public.teams set lead_id = v_lead where id = v_team;
    end if;
    -- CAM
    select id into v_cam from public.employees where email = lower(trim(r ->> 'cam_email'));
    if v_cam is null then
      insert into public.employees (email, full_name, role, team_id)
      values (lower(trim(r ->> 'cam_email')), coalesce(nullif(trim(r ->> 'cam_name'), ''), split_part(r ->> 'cam_email', '@', 1)), 'user', v_team)
      returning id into v_cam;
      n_cams := n_cams + 1;
    elsif (select team_id from public.employees where id = v_cam) is distinct from v_team then
      update public.employees set team_id = v_team where id = v_cam;
      n_moved := n_moved + 1;
    end if;
  end loop;
  return jsonb_build_object('rows', i, 'new_leads', n_leads, 'new_teams', n_teams, 'new_cams', n_cams, 'reassigned', n_moved, 'rejected', n_rej, 'errors', errors);
end $$;

revoke execute on function public.weekly_email_preview(uuid), public.queue_weekly_report_emails(uuid, uuid[], boolean),
  public.import_team_mapping(jsonb), public._html_escape(text), public.on_period_published_emails() from public, anon;
grant execute on function public.weekly_email_preview(uuid), public.queue_weekly_report_emails(uuid, uuid[], boolean),
  public.import_team_mapping(jsonb) to authenticated;
grant execute on function public.queue_weekly_report_emails(uuid, uuid[], boolean) to service_role;
