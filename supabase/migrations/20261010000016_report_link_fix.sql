-- Weekly report link: portal_url may end with '#' (hash routing); don't double it.
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
  if not (public.is_qa() or public.is_service_role() or session_user = 'postgres') then
    raise exception 'Only QA can send weekly report emails' using errcode = '42501';
  end if;
  select * into p from public.reporting_periods where id = p_period;
  if p.id is null then raise exception 'Audit week not found'; end if;
  if p.status <> 'published' then raise exception 'Publish % before emailing CAMs — the report link would show nothing yet', p.short_label; end if;
  if portal = '' then raise exception 'Set the portal URL (Reporting & Settings → Notifications) so the email can link to the report'; end if;

  v_range := to_char(p.start_date, 'MM/DD') || '–' || to_char(p.end_date, 'MM/DD/YYYY');
  v_link := rtrim(portal, '/#') || '/#/?mode=week&period=' || p.id;

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

