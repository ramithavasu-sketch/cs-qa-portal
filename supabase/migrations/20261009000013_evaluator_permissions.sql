-- =============================================================================
-- QA Evaluator permissions. Evaluators see what QA sees (all teams, draft weeks,
-- appeals, internal comments) and can decide appeals (including on their own
-- audits), correct scores, publish weeks, set appeal closing dates and send the
-- weekly emails. Users, teams, scoring, settings, data import, historical names
-- and the audit log stay Super Admin only.
-- Function bodies below are the latest versions with only their permission check
-- changed (generated from the earlier migrations). Safe to run more than once.
-- =============================================================================
create or replace function public.is_qa()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('super_admin', 'evaluator'), false)
$$;
revoke execute on function public.is_qa() from public, anon;
grant execute on function public.is_qa() to authenticated, service_role;

-- qa_request_info (from 20261007000008_brief_gaps.sql)
create or replace function public.qa_request_info(p_appeal uuid, p_from text, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_days int := coalesce((public.get_setting('sla') ->> 'clarification_days')::int, 2);
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can request information' using errcode = '42501'; end if;
  if p_from not in ('cam', 'lead') then raise exception 'Request information from cam or lead'; end if;
  select * into a from public.appeals where id = p_appeal for update;
  if a.status <> 'pending_qa_review' then raise exception 'Appeal is not pending QA review'; end if;
  if p_comment is null or length(trim(p_comment)) < 5 then raise exception 'Please describe the information needed'; end if;
  update public.appeals set info_requested_from = p_from, info_due_at = public.add_business_days(now(), v_days) where id = p_appeal;
  perform public._set_appeal_status(p_appeal, 'pending_additional_info');
  perform public._appeal_event(p_appeal, me, 'qa_requested_info', p_comment, 'shared', 'pending_qa_review', 'pending_additional_info');
  perform public.notify(case when p_from = 'cam' then a.cam_id else a.lead_id end, 'appeal_info_requested',
    'QA requested information on appeal ' || a.reference,
    public._appeal_msg(p_appeal, 'QA needs additional information to decide this appeal. Please respond by '
      || to_char(public.add_business_days(now(), v_days), 'DD Mon YYYY') || '.'),
    '/appeals/' || p_appeal, p_appeal);
end $$;

-- qa_decide_appeal (from 20261007000008_brief_gaps.sql)
create or replace function public.qa_decide_appeal(
  p_appeal uuid, p_decisions jsonb, p_resolution text, p_extra_adjustments jsonb default '[]'::jsonb)
returns public.appeal_status language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  ev public.evaluations;
  d jsonb;
  it public.appeal_items;
  v_dec public.item_decision;
  v_rev numeric;
  v_max numeric;
  v_cur numeric;
  v_reason text;
  v_approved int := 0;
  v_rejected int := 0;
  v_total int;
  v_final public.appeal_status;
  x jsonb;
  v_param uuid;
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can decide appeals' using errcode = '42501'; end if;
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if a.status <> 'pending_qa_review' then
    raise exception 'Appeal must be forwarded by the Team Lead before QA can decide (current status: %)', a.status;
  end if;
  if p_resolution is null or length(trim(p_resolution)) < 10 then
    raise exception 'Resolution remarks are required (at least 10 characters)';
  end if;
  select * into ev from public.evaluations where id = a.evaluation_id;
  select count(*) into v_total from public.appeal_items where appeal_id = p_appeal;
  if jsonb_array_length(coalesce(p_decisions, '[]'::jsonb)) <> v_total then
    raise exception 'A decision is required for every disputed parameter';
  end if;

  for d in select * from jsonb_array_elements(p_decisions) loop
    select * into it from public.appeal_items where id = (d ->> 'item_id')::uuid and appeal_id = p_appeal;
    if it.id is null then raise exception 'Decision refers to an item that is not part of this appeal'; end if;
    v_dec := (d ->> 'decision')::public.item_decision;
    if v_dec not in ('approved', 'rejected') then raise exception 'Decision must be approved or rejected'; end if;
    v_reason := nullif(trim(d ->> 'reason'), '');

    if v_dec = 'approved' then
      v_approved := v_approved + 1;
      if it.is_autofail then
        v_cur := case when public._effective_autofail(ev.id) then 1 else 0 end;
        v_rev := 0;
        if v_reason is null or length(v_reason) < 5 then
          raise exception 'A reason for the score adjustment is required for every approved parameter';
        end if;
        if v_cur <> 0 then
          insert into public.score_adjustments (evaluation_id, kind, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
          values (ev.id, 'autofail', v_cur, 0, v_reason, p_appeal, it.id, me.id);
        end if;
      else
        v_rev := nullif(d ->> 'revised_score', '')::numeric;
        select s.max_score into v_max from public.evaluation_scores s where s.evaluation_id = ev.id and s.parameter_id = it.parameter_id;
        if v_rev is null or v_rev < 0 or v_rev > v_max then
          raise exception 'Approved items need a revised score between 0 and %', v_max;
        end if;
        v_cur := public._effective_param(ev.id, it.parameter_id);
        if v_cur is not distinct from v_rev then
          raise exception 'Revised score equals the current score; reject the item instead';
        end if;
        if v_reason is null or length(v_reason) < 5 then
          raise exception 'A reason for the score adjustment is required for every approved parameter';
        end if;
        insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
        values (ev.id, 'parameter', it.parameter_id, coalesce(v_cur, 0), v_rev, v_reason, p_appeal, it.id, me.id);
      end if;
    else
      v_rejected := v_rejected + 1;
      v_rev := null;
      if exists (select 1 from public.score_adjustments where appeal_item_id = it.id) then
        if it.is_autofail and not public._effective_autofail(ev.id) then
          insert into public.score_adjustments (evaluation_id, kind, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
          values (ev.id, 'autofail', 0, 1, 'Appeal re-decided: ' || trim(p_resolution), p_appeal, it.id, me.id);
        elsif not it.is_autofail and public._effective_param(ev.id, it.parameter_id) is distinct from it.original_score then
          insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
          values (ev.id, 'parameter', it.parameter_id, public._effective_param(ev.id, it.parameter_id), it.original_score,
                  'Appeal re-decided: ' || trim(p_resolution), p_appeal, it.id, me.id);
        end if;
      end if;
    end if;

    update public.appeal_items
       set decision = v_dec, revised_score = v_rev,
           decision_reason = coalesce(v_reason, trim(p_resolution)),
           decided_by = me.id, decided_at = now()
     where id = it.id;
  end loop;

  if jsonb_array_length(coalesce(p_extra_adjustments, '[]'::jsonb)) > 0 then
    if v_approved = 0 then raise exception 'Additional score changes are only allowed when at least one item is approved'; end if;
    for x in select * from jsonb_array_elements(p_extra_adjustments) loop
      v_param := (x ->> 'parameter_id')::uuid;
      v_rev := (x ->> 'revised_score')::numeric;
      select s.max_score into v_max from public.evaluation_scores s where s.evaluation_id = ev.id and s.parameter_id = v_param;
      if v_max is null then raise exception 'Parameter is not part of this evaluation'; end if;
      if v_rev is null or v_rev < 0 or v_rev > v_max then raise exception 'Revised score must be between 0 and %', v_max; end if;
      if length(trim(coalesce(x ->> 'reason', ''))) < 5 then raise exception 'A reason is required for each additional score change'; end if;
      insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, appeal_id, approved_by)
      values (ev.id, 'parameter', v_param, coalesce(public._effective_param(ev.id, v_param), 0), v_rev, trim(x ->> 'reason'), p_appeal, me.id);
    end loop;
  end if;

  v_final := case when v_rejected = 0 then 'approved'
                  when v_approved = 0 then 'rejected'
                  else 'partially_approved' end;
  update public.appeals set decided_at = now(), decided_by = me.id, resolution_note = trim(p_resolution),
         info_requested_from = null, info_due_at = null where id = p_appeal;
  perform public._set_appeal_status(p_appeal, v_final);
  perform public._appeal_event(p_appeal, me, 'qa_decided', p_resolution, 'shared', 'pending_qa_review', v_final);
  perform public.notify(a.cam_id, 'appeal_decided', 'Decision on appeal ' || a.reference,
    public._appeal_msg(p_appeal, 'QA has made a final decision on your appeal.'), '/appeals/' || p_appeal, p_appeal);
  perform public.notify(a.lead_id, 'appeal_decided', 'Decision on appeal ' || a.reference,
    public._appeal_msg(p_appeal, 'QA has made a final decision on an appeal from your team.'), '/appeals/' || p_appeal, p_appeal);
  if v_approved > 0 then
    perform public.notify(a.cam_id, 'score_changed', 'Score updated for task ' || ev.task_id,
      public._appeal_msg(p_appeal, 'A finalized score was changed following this appeal.'), '/evaluations/' || ev.id, p_appeal);
  end if;
  return v_final;
end $$;

-- qa_reopen_appeal (from 20261007000008_brief_gaps.sql)
create or replace function public.qa_reopen_appeal(p_appeal uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can reopen appeals' using errcode = '42501'; end if;
  select * into a from public.appeals where id = p_appeal for update;
  if a.status not in ('approved', 'partially_approved', 'rejected', 'closed') then
    raise exception 'Only decided or closed appeals can be reopened';
  end if;
  if a.status = 'closed' and a.forwarded_at is null then
    raise exception 'This appeal was withdrawn before Lead review and cannot be reopened by QA';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'A reason is required to reopen'; end if;
  -- The previous decision stays in the timeline, the audit log and score_adjustments.
  update public.appeal_items set decision = 'pending', decided_by = null, decided_at = null where appeal_id = p_appeal;
  update public.appeals set decided_at = null, decided_by = null, resolution_note = null where id = p_appeal;
  perform public._set_appeal_status(p_appeal, 'pending_qa_review');
  perform public._appeal_event(p_appeal, me, 'qa_reopened', p_reason, 'shared', a.status, 'pending_qa_review');
  perform public.notify(a.cam_id, 'appeal_reopened', 'Appeal ' || a.reference || ' reopened',
    public._appeal_msg(p_appeal, 'QA has reopened your appeal for further review.'), '/appeals/' || p_appeal, p_appeal);
  perform public.notify(a.lead_id, 'appeal_reopened', 'Appeal ' || a.reference || ' reopened',
    public._appeal_msg(p_appeal, 'QA has reopened an appeal from your team for further review.'), '/appeals/' || p_appeal, p_appeal);
end $$;

-- grant_appeal_resubmission (from 20260929000003_workflow.sql)
create or replace function public.grant_appeal_resubmission(p_evaluation uuid, p_parameter uuid, p_is_autofail boolean, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me(); v_id uuid;
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can grant resubmissions' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'A reason is required'; end if;
  insert into public.appeal_resubmission_grants (evaluation_id, parameter_id, is_autofail, granted_by, reason)
  values (p_evaluation, case when p_is_autofail then null else p_parameter end, p_is_autofail, me.id, trim(p_reason))
  returning id into v_id;
  return v_id;
end $$;

-- admin_adjust_score (from 20260929000003_workflow.sql)
create or replace function public.admin_adjust_score(p_evaluation uuid, p_parameter uuid, p_revised numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  ev public.evaluations;
  v_max numeric;
  v_cur numeric;
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can change finalized scores' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 10 then raise exception 'A reason (min 10 characters) is required'; end if;
  select * into ev from public.evaluations where id = p_evaluation;
  if ev.id is null then raise exception 'Evaluation not found'; end if;
  if p_parameter is null then
    if p_revised not in (0, 1) then raise exception 'Autofail value must be 0 (no) or 1 (yes)'; end if;
    v_cur := case when public._effective_autofail(ev.id) then 1 else 0 end;
    if v_cur = p_revised then raise exception 'No change'; end if;
    insert into public.score_adjustments (evaluation_id, kind, original_value, revised_value, reason, approved_by)
    values (ev.id, 'autofail', v_cur, p_revised, trim(p_reason), me.id);
  else
    select s.max_score into v_max from public.evaluation_scores s where s.evaluation_id = ev.id and s.parameter_id = p_parameter;
    if v_max is null then raise exception 'Parameter is not part of this evaluation'; end if;
    if p_revised < 0 or p_revised > v_max then raise exception 'Score must be between 0 and %', v_max; end if;
    v_cur := public._effective_param(ev.id, p_parameter);
    if v_cur is not distinct from p_revised then raise exception 'No change'; end if;
    insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, approved_by)
    values (ev.id, 'parameter', p_parameter, coalesce(v_cur, 0), p_revised, trim(p_reason), me.id);
  end if;
  perform public.notify(ev.cam_id, 'score_changed', 'Score updated for task ' || ev.task_id,
    'QA updated a finalized score on one of your evaluations.', '/evaluations/' || ev.id, null);
end $$;

-- set_period_status (from 20260929000003_workflow.sql)
create or replace function public.set_period_status(p_period uuid, p_status public.period_status)
returns void language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me();
begin
  if me.role not in ('super_admin', 'evaluator') then raise exception 'Only QA can publish reports' using errcode = '42501'; end if;
  update public.reporting_periods
     set status = p_status,
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
         published_by = case when p_status = 'published' then me.id else published_by end
   where id = p_period;
end $$;

-- close_appeal (from 20261007000008_brief_gaps.sql)
create or replace function public.close_appeal(p_appeal uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if me.role in ('super_admin', 'evaluator') then
    if a.status = 'closed' then raise exception 'Appeal is already closed'; end if;
  elsif a.cam_id = me.id then
    if a.status not in ('draft', 'pending_lead_review', 'returned_to_cam') then
      raise exception 'You can only withdraw an appeal before it is forwarded to QA';
    end if;
  else
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 3 then raise exception 'Please give a reason'; end if;
  perform public._set_appeal_status(p_appeal, 'closed');
  perform public._appeal_event(p_appeal, me, 'closed', p_reason, 'shared', a.status, 'closed');
  if me.id <> a.cam_id then
    perform public.notify(a.cam_id, 'appeal_decided', 'Appeal ' || a.reference || ' closed',
      public._appeal_msg(p_appeal, 'Your appeal has been closed by QA.'), '/appeals/' || p_appeal, p_appeal);
  elsif a.status <> 'draft' then
    perform public.notify(a.lead_id, 'appeal_decided', 'Appeal ' || a.reference || ' withdrawn',
      public._appeal_msg(p_appeal, 'The CAM withdrew this appeal.'), '/appeals/' || p_appeal, p_appeal);
  end if;
end $$;

-- share_appeal_comment (from 20261007000008_brief_gaps.sql)
create or replace function public.share_appeal_comment(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  ev public.appeal_events;
begin
  select * into ev from public.appeal_events where id = p_event for update;
  if ev.id is null or not public.can_view_appeal(ev.appeal_id) then raise exception 'Not authorised' using errcode = '42501'; end if;
  if me.role = 'user' or not (ev.actor_id = me.id or me.role in ('super_admin', 'evaluator')) then
    raise exception 'Only the author or QA can share this comment' using errcode = '42501';
  end if;
  if ev.visibility <> 'internal' then raise exception 'This comment is already visible to the CAM'; end if;
  update public.appeal_events set visibility = 'shared' where id = p_event;
  perform public._appeal_event(ev.appeal_id, me, 'comment_shared', 'An internal comment was shared with the CAM.', 'internal', null, null);
end $$;

-- weekly_email_preview (from 20260929000006_weekly_emails_and_mapping.sql)
create or replace function public.weekly_email_preview(p_period uuid)
returns table (cam_id uuid, cam_name text, cam_email text, cam_active boolean, lead_name text, lead_email text,
               tasks int, last_status text, last_sent_at timestamptz, last_error text, last_queued_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_qa() then raise exception 'Only QA can send weekly report emails' using errcode = '42501'; end if;
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

-- queue_weekly_report_emails (from 20260929000006_weekly_emails_and_mapping.sql)
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

-- notify_super_admins (from 20260929000003_workflow.sql)
create or replace function public.notify_super_admins(p_type text, p_title text, p_message text, p_link text, p_appeal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.employees where role in ('super_admin', 'evaluator') and status = 'active' loop
    perform public.notify(r.id, p_type, p_title, p_message, p_link, p_appeal);
  end loop;
end $$;

-- can_view_cam (from 20260929000002_security.sql)
create or replace function public.can_view_cam(p_cam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_qa()
      or p_cam = public.my_employee_id()
      or public.is_lead_of(p_cam)
$$;

-- can_view_evaluation (from 20260929000002_security.sql)
create or replace function public.can_view_evaluation(p_eval uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.evaluations e
    where e.id = p_eval
      and (public.is_qa()
           or (public.can_view_cam(e.cam_id) and public.period_is_published(e.period_id)))
  )
$$;

-- can_view_appeal (from 20260929000002_security.sql)
create or replace function public.can_view_appeal(p_appeal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.appeals a
    where a.id = p_appeal
      and (public.is_qa()
           or a.cam_id = public.my_employee_id()
           or (public.my_role() = 'admin' and (a.lead_id = public.my_employee_id() or public.is_lead_of(a.cam_id))))
  )
$$;

-- my_visible_cam_ids (from 20261008000011_rls_performance.sql)
create or replace function public.my_visible_cam_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select e.id from public.employees e where public.is_qa()
  union
  select public.my_employee_id() where public.my_employee_id() is not null
  union
  select c.id from public.employees c join public.teams t on t.id = c.team_id
   where public.my_role() = 'admin' and t.lead_id = public.my_employee_id()
$$;

-- my_visible_period_ids (from 20261008000011_rls_performance.sql)
create or replace function public.my_visible_period_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from public.reporting_periods p
   where public.is_qa() or (p.status = 'published' and public.my_employee_id() is not null)
$$;


-- ---------------------------------------------------------------------------
-- Row Level Security: QA (Super Admin or Evaluator) reads
-- ---------------------------------------------------------------------------
drop policy if exists periods_select on public.reporting_periods;
create policy periods_select on public.reporting_periods for select to authenticated using (
  (select public.is_qa()) or (status = 'published' and (select public.my_employee_id()) is not null)
);
-- Evaluators may set a week's appeal closing date / auto-publish time (status only via set_period_status;
-- other fields are protected by guard_period_status below).
drop policy if exists periods_update_evaluator on public.reporting_periods;
create policy periods_update_evaluator on public.reporting_periods for update to authenticated
  using (public.my_role() = 'evaluator') with check (public.my_role() = 'evaluator');

drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees for select to authenticated using (
  public.is_qa()
  or id = public.my_employee_id()
  or public.is_lead_of(id)
  or role in ('admin', 'super_admin', 'evaluator')
);

drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated using (
  (select public.is_qa())
  or (cam_id in (select public.my_visible_cam_ids()) and period_id in (select public.my_visible_period_ids()))
);
drop policy if exists evaluation_scores_select on public.evaluation_scores;
create policy evaluation_scores_select on public.evaluation_scores for select to authenticated using (
  (select public.is_qa()) or evaluation_id in (select e.id from public.evaluations e)
);
drop policy if exists score_adjustments_select on public.score_adjustments;
create policy score_adjustments_select on public.score_adjustments for select to authenticated using (
  (select public.is_qa()) or evaluation_id in (select e.id from public.evaluations e)
);
drop policy if exists appeal_events_select on public.appeal_events;
create policy appeal_events_select on public.appeal_events for select to authenticated using (
  public.can_view_appeal(appeal_id)
  and (visibility = 'shared' or public.my_role() in ('admin', 'super_admin', 'evaluator'))
);
drop policy if exists grants_select on public.appeal_resubmission_grants;
create policy grants_select on public.appeal_resubmission_grants for select to authenticated using (
  public.is_qa() or public.can_view_evaluation(evaluation_id)
);
drop policy if exists weekly_report_emails_select on public.weekly_report_emails;
create policy weekly_report_emails_select on public.weekly_report_emails for select to authenticated using (public.is_qa());

-- Evaluators may only change a week's appeal closing date and auto-publish time directly.
create or replace function public.guard_period_status()
returns trigger language plpgsql as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' and new.status <> 'draft' then
      raise exception 'New weeks start as drafts. Publish them from Audit Weeks.';
    end if;
    if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.published_at is distinct from old.published_at) then
      raise exception 'Use Publish / Unpublish to change a week''s status.';
    end if;
    if tg_op = 'UPDATE' and public.my_role() = 'evaluator'
       and (to_jsonb(new) - 'appeal_closes_at' - 'auto_publish_at') is distinct from (to_jsonb(old) - 'appeal_closes_at' - 'auto_publish_at') then
      raise exception 'Evaluators can only change a week''s appeal closing date and auto-publish time.';
    end if;
  end if;
  return new;
end $$;
