-- =============================================================================
-- Gap fixes from the October 2026 review against the project brief.
--   * Appeals: race-safe duplicate check, closed appeals can be resubmitted,
--     editable drafts, weekly limit also on draft submission, CAM receipt,
--     internal comments can be shared, per-parameter reason required on
--     approval, reopen clears the previous decision.
--   * Notifications: every message carries reference, task id and status;
--     working report link; "report published" also for weeks created already
--     published by an import; due-soon reminders; email switches independent
--     of in-app switches.
--   * Weekly auto-publish schedule (reporting.auto_publish*) now takes effect.
--   * Audit log: appeal creation, every appeal action (with its reason) and
--     item decisions are logged.
--   * Server-side validation: settings, employee e-mail, team leads, last
--     Super Admin protection, week status only via set_period_status.
--   * Scoring criteria text per parameter (shown to QA/CAM during appeals).
--   * Extra indexes.
-- Safe to run once on an existing database (SQL editor or `supabase db push`).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------
alter table public.evaluation_parameters add column if not exists criteria text;
comment on column public.evaluation_parameters.criteria is 'Rubric / scoring guidance shown during appeal review';

create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id);
create index if not exists audit_logs_action_idx on public.audit_logs (action);
create index if not exists score_adjustments_appeal_idx on public.score_adjustments (appeal_id);
create index if not exists evaluations_audited_at_idx on public.evaluations (audited_at);
create index if not exists evaluations_task_id_idx on public.evaluations (task_id);
create index if not exists notifications_unread_idx on public.notifications (recipient_id) where read_at is null;

-- E-mail format (NOT VALID: enforced for new/changed rows without rechecking history).
alter table public.employees drop constraint if exists employees_email_format;
alter table public.employees add constraint employees_email_format
  check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') not valid;

-- ---------------------------------------------------------------------------
-- Notifications: in-app and e-mail switches are independent.
-- ---------------------------------------------------------------------------
create or replace function public.notify(
  p_recipient uuid, p_type text, p_title text, p_message text,
  p_link text default null, p_appeal uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  cfg jsonb := coalesce(public.get_setting('notifications'), '{}'::jsonb);
  emp public.employees;
begin
  select * into emp from public.employees where id = p_recipient;
  if emp.id is null or emp.status <> 'active' then return; end if;
  if coalesce((cfg -> 'in_app' ->> p_type)::boolean, true) then
    insert into public.notifications (recipient_id, type, title, message, link, appeal_id)
    values (p_recipient, p_type, p_title, p_message, p_link, p_appeal);
  end if;
  if coalesce((cfg ->> 'email_enabled')::boolean, false)
     and coalesce((cfg -> 'email' ->> p_type)::boolean, true) then
    insert into public.email_outbox (recipient_email, subject, body_text)
    values (emp.email, '[CS QA Portal] ' || p_title,
            p_message || E'\n\nOpen the portal to view details: ' ||
            coalesce(cfg ->> 'portal_url', '') || coalesce(p_link, '') ||
            E'\n\nThis message is confidential and intended only for the recipient.');
  end if;
end $$;

-- Standard appeal message: reference, task id and current status (no scores or feedback).
create or replace function public._appeal_msg(p_appeal uuid, p_lead_in text)
returns text language sql stable security definer set search_path = public as $$
  select p_lead_in || ' Appeal: ' || a.reference || ' · Task: ' || e.task_id
         || ' · Status: ' || initcap(replace(a.status::text, '_', ' ')) || '.'
  from public.appeals a join public.evaluations e on e.id = a.evaluation_id
  where a.id = p_appeal
$$;

-- ---------------------------------------------------------------------------
-- Appeal items (shared by submit + draft edit)
-- ---------------------------------------------------------------------------
create or replace function public._insert_appeal_items(p_appeal uuid, p_eval uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  v_param uuid;
  v_is_af boolean;
  v_req numeric;
  v_max numeric;
  v_orig numeric;
  v_grant uuid;
  v_seen text[] := '{}';
  v_key text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one disputed parameter';
  end if;
  -- Serialise appeal creation per task so two simultaneous submissions cannot both pass the duplicate check.
  perform pg_advisory_xact_lock(hashtext('appeal:' || p_eval::text));

  for it in select * from jsonb_array_elements(p_items) loop
    v_is_af := coalesce((it ->> 'is_autofail')::boolean, false);
    v_param := nullif(it ->> 'parameter_id', '')::uuid;
    v_req := nullif(it ->> 'requested_score', '')::numeric;
    v_key := case when v_is_af then 'AF' else coalesce(v_param::text, '') end;
    if v_key = any (v_seen) then raise exception 'The same parameter was selected twice'; end if;
    v_seen := v_seen || v_key;

    if v_is_af then
      if not public._effective_autofail(p_eval) then
        raise exception 'This evaluation is not marked as an autofail';
      end if;
      v_orig := 1; v_max := 1; v_param := null;
    else
      select s.max_score into v_max from public.evaluation_scores s
      where s.evaluation_id = p_eval and s.parameter_id = v_param;
      if v_max is null then
        raise exception 'Parameter % is not part of this evaluation', coalesce(v_param::text, '(missing)');
      end if;
      v_orig := public._effective_param(p_eval, v_param);
      if v_req is not null and (v_req < 0 or v_req > v_max) then
        raise exception 'Requested score must be between 0 and %', v_max;
      end if;
    end if;

    -- Duplicate protection: any appeal on the same task + parameter that is not closed blocks,
    -- unless QA has granted a resubmission.
    if exists (
      select 1 from public.appeal_items ai join public.appeals a on a.id = ai.appeal_id
      where a.evaluation_id = p_eval and a.id <> p_appeal and a.status <> 'closed'
        and ai.is_autofail = v_is_af
        and (ai.parameter_id is not distinct from v_param)
    ) then
      select g.id into v_grant from public.appeal_resubmission_grants g
      where g.evaluation_id = p_eval and g.used_at is null and g.is_autofail = v_is_af
        and g.parameter_id is not distinct from v_param
      order by g.created_at limit 1;
      if v_grant is null then
        raise exception 'An appeal for this task and parameter already exists';
      end if;
      update public.appeal_resubmission_grants set used_at = now() where id = v_grant;
      v_grant := null;
    end if;

    insert into public.appeal_items (appeal_id, parameter_id, is_autofail, original_score, requested_score)
    values (p_appeal, v_param, v_is_af, v_orig, case when v_is_af then 0 else v_req end);
  end loop;
end $$;

create or replace function public._check_appeal_limit(p_cam uuid, p_period uuid, p_exclude uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_limit int; v_count int;
begin
  v_limit := (public.get_setting('appeal_window') ->> 'max_appeals_per_cam_per_period')::int;
  if v_limit is null then return; end if;
  select count(*) into v_count
  from public.appeals a join public.evaluations e2 on e2.id = a.evaluation_id
  where a.cam_id = p_cam and e2.period_id = p_period and a.status not in ('draft', 'closed')
    and a.id is distinct from p_exclude;
  if v_count >= v_limit then
    raise exception 'You have reached the maximum of % appeal(s) for this audit week', v_limit;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CAM: submit appeal (or save a draft)
-- ---------------------------------------------------------------------------
create or replace function public.submit_appeal(
  p_evaluation_id uuid, p_reason text, p_items jsonb, p_as_draft boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  ev public.evaluations;
  v_lead uuid;
  v_deadline timestamptz;
  v_appeal uuid;
  v_status public.appeal_status := case when p_as_draft then 'draft' else 'pending_lead_review' end;
  v_ref text;
begin
  select * into ev from public.evaluations where id = p_evaluation_id;
  if ev.id is null or ev.cam_id <> me.id then
    raise exception 'You can only appeal your own evaluations' using errcode = '42501';
  end if;
  if not public.period_is_published(ev.period_id) then
    raise exception 'This evaluation has not been published yet';
  end if;
  v_deadline := public.appeal_deadline(ev.id);
  if now() > v_deadline then
    raise exception 'The appeal window for this evaluation closed on %', to_char(v_deadline, 'DD Mon YYYY');
  end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'Please give a detailed reason for the appeal (at least 20 characters)';
  end if;

  select t.lead_id into v_lead from public.teams t where t.id = me.team_id;
  if v_lead is null then
    raise exception 'No Team Lead is assigned to your team. Please contact the QA team.';
  end if;
  if not p_as_draft then perform public._check_appeal_limit(me.id, ev.period_id, null); end if;

  v_ref := 'APL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.appeal_ref_seq')::text, 5, '0');
  insert into public.appeals (reference, evaluation_id, cam_id, lead_id, status, reason, submitted_at, is_demo)
  values (v_ref, ev.id, me.id, v_lead, v_status, trim(p_reason),
          case when p_as_draft then null else now() end, ev.is_demo)
  returning id into v_appeal;

  perform public._insert_appeal_items(v_appeal, ev.id, p_items);

  perform public._appeal_event(v_appeal, me, case when p_as_draft then 'draft_saved' else 'submitted' end,
                               null, 'shared', null, v_status);
  if not p_as_draft then
    perform public.notify(v_lead, 'appeal_submitted', 'New appeal ' || v_ref || ' awaiting your review',
      public._appeal_msg(v_appeal, 'A CAM in your team submitted an appeal for your review.'), '/appeals/' || v_appeal, v_appeal);
    perform public.notify(me.id, 'appeal_submitted', 'Appeal ' || v_ref || ' submitted',
      public._appeal_msg(v_appeal, 'Your appeal was submitted and sent to your Team Lead.'), '/appeals/' || v_appeal, v_appeal);
  end if;
  return v_appeal;
end $$;

-- CAM: edit a draft before submitting it.
create or replace function public.update_draft_appeal(p_appeal uuid, p_reason text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null or a.cam_id <> me.id then raise exception 'Not authorised' using errcode = '42501'; end if;
  if a.status <> 'draft' then raise exception 'Only drafts can be edited'; end if;
  if p_reason is null or length(trim(p_reason)) < 20 then
    raise exception 'Please give a detailed reason for the appeal (at least 20 characters)';
  end if;
  update public.appeals set reason = trim(p_reason) where id = p_appeal;
  delete from public.appeal_items where appeal_id = p_appeal;
  perform public._insert_appeal_items(p_appeal, a.evaluation_id, p_items);
  perform public._appeal_event(p_appeal, me, 'draft_saved', null, 'shared', null, null);
end $$;

create or replace function public.submit_draft_appeal(p_appeal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_lead uuid;
  v_period uuid;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null or a.cam_id <> me.id then raise exception 'Not authorised' using errcode = '42501'; end if;
  if a.status <> 'draft' then raise exception 'Only drafts can be submitted'; end if;
  if now() > public.appeal_deadline(a.evaluation_id) then raise exception 'The appeal window has closed'; end if;
  select t.lead_id into v_lead from public.teams t where t.id = me.team_id;
  if v_lead is null then raise exception 'No Team Lead is assigned to your team. Please contact the QA team.'; end if;
  select period_id into v_period from public.evaluations where id = a.evaluation_id;
  perform public._check_appeal_limit(me.id, v_period, p_appeal);
  update public.appeals set lead_id = v_lead, submitted_at = now() where id = p_appeal;
  perform public._set_appeal_status(p_appeal, 'pending_lead_review');
  perform public._appeal_event(p_appeal, me, 'submitted', null, 'shared', 'draft', 'pending_lead_review');
  perform public.notify(v_lead, 'appeal_submitted', 'New appeal ' || a.reference || ' awaiting your review',
    public._appeal_msg(p_appeal, 'A CAM in your team submitted an appeal for your review.'), '/appeals/' || p_appeal, p_appeal);
  perform public.notify(me.id, 'appeal_submitted', 'Appeal ' || a.reference || ' submitted',
    public._appeal_msg(p_appeal, 'Your appeal was submitted and sent to your Team Lead.'), '/appeals/' || p_appeal, p_appeal);
end $$;

-- ---------------------------------------------------------------------------
-- Team Lead review
-- ---------------------------------------------------------------------------
create or replace function public.lead_review_appeal(
  p_appeal uuid, p_recommendation public.lead_recommendation, p_comment text,
  p_internal_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_days int := coalesce((public.get_setting('sla') ->> 'clarification_days')::int, 2);
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if me.role <> 'admin' or not (a.lead_id = me.id or public.is_lead_of(a.cam_id)) then
    raise exception 'Only the CAM''s Team Lead can review this appeal' using errcode = '42501';
  end if;
  if a.status <> 'pending_lead_review' then
    raise exception 'This appeal is not awaiting Lead review (current status: %)', a.status;
  end if;
  if p_comment is null or length(trim(p_comment)) < 5 then
    raise exception 'Please add a comment for your recommendation';
  end if;

  if p_internal_note is not null and length(trim(p_internal_note)) > 0 then
    perform public._appeal_event(p_appeal, me, 'comment', p_internal_note, 'internal', null, null);
  end if;

  if p_recommendation = 'request_more_info' then
    update public.appeals set info_requested_from = 'cam',
      info_due_at = public.add_business_days(now(), v_days) where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'returned_to_cam');
    perform public._appeal_event(p_appeal, me, 'lead_returned', p_comment, 'shared',
                                 'pending_lead_review', 'returned_to_cam', p_recommendation);
    perform public.notify(a.cam_id, 'appeal_returned', 'Appeal ' || a.reference || ' returned for clarification',
      public._appeal_msg(p_appeal, 'Your Team Lead has requested more information. Please respond by '
        || to_char(public.add_business_days(now(), v_days), 'DD Mon YYYY') || '.'),
      '/appeals/' || p_appeal, p_appeal);
  else
    update public.appeals set lead_recommendation = p_recommendation, forwarded_at = now(),
      info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_qa_review');
    perform public._appeal_event(p_appeal, me, 'lead_forwarded', p_comment, 'shared',
                                 'pending_lead_review', 'pending_qa_review', p_recommendation);
    perform public.notify_super_admins('appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      public._appeal_msg(p_appeal, 'The Team Lead has reviewed this appeal and forwarded it to QA.'), '/appeals/' || p_appeal, p_appeal);
    perform public.notify(a.cam_id, 'appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      public._appeal_msg(p_appeal, 'Your Team Lead has reviewed your appeal and forwarded it to QA.'), '/appeals/' || p_appeal, p_appeal);
  end if;
end $$;

create or replace function public.respond_to_appeal_request(p_appeal uuid, p_response text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if p_response is null or length(trim(p_response)) < 5 then raise exception 'Please enter a response'; end if;

  if a.status = 'returned_to_cam' then
    if a.cam_id <> me.id then raise exception 'Only the CAM can respond' using errcode = '42501'; end if;
    update public.appeals set info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_lead_review');
    perform public._appeal_event(p_appeal, me, 'cam_responded', p_response, 'shared', 'returned_to_cam', 'pending_lead_review');
    perform public.notify(a.lead_id, 'appeal_submitted', 'CAM responded on appeal ' || a.reference,
      public._appeal_msg(p_appeal, 'The CAM has provided the requested information.'), '/appeals/' || p_appeal, p_appeal);
  elsif a.status = 'pending_additional_info' then
    if (a.info_requested_from = 'cam' and a.cam_id <> me.id)
       or (a.info_requested_from = 'lead' and not (me.role = 'admin' and (a.lead_id = me.id or public.is_lead_of(a.cam_id)))) then
      raise exception 'You are not the person QA requested information from' using errcode = '42501';
    end if;
    update public.appeals set info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_qa_review');
    perform public._appeal_event(p_appeal, me, case when me.id = a.cam_id then 'cam_responded' else 'lead_responded' end,
                                 p_response, 'shared', 'pending_additional_info', 'pending_qa_review');
    perform public.notify_super_admins('appeal_forwarded', 'Response received on appeal ' || a.reference,
      public._appeal_msg(p_appeal, 'The requested information has been provided.'), '/appeals/' || p_appeal, p_appeal);
  else
    raise exception 'No information has been requested on this appeal';
  end if;
end $$;

-- Lead/QA: make an internal comment visible to the CAM. Only the author or QA may share it.
create or replace function public.share_appeal_comment(p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  ev public.appeal_events;
begin
  select * into ev from public.appeal_events where id = p_event for update;
  if ev.id is null or not public.can_view_appeal(ev.appeal_id) then raise exception 'Not authorised' using errcode = '42501'; end if;
  if me.role = 'user' or not (ev.actor_id = me.id or me.role = 'super_admin') then
    raise exception 'Only the author or QA can share this comment' using errcode = '42501';
  end if;
  if ev.visibility <> 'internal' then raise exception 'This comment is already visible to the CAM'; end if;
  update public.appeal_events set visibility = 'shared' where id = p_event;
  perform public._appeal_event(ev.appeal_id, me, 'comment_shared', 'An internal comment was shared with the CAM.', 'internal', null, null);
end $$;

-- ---------------------------------------------------------------------------
-- QA
-- ---------------------------------------------------------------------------
create or replace function public.qa_request_info(p_appeal uuid, p_from text, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_days int := coalesce((public.get_setting('sla') ->> 'clarification_days')::int, 2);
begin
  if me.role <> 'super_admin' then raise exception 'Only QA can request information' using errcode = '42501'; end if;
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
  if me.role <> 'super_admin' then raise exception 'Only QA can decide appeals' using errcode = '42501'; end if;
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

create or replace function public.qa_reopen_appeal(p_appeal uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  if me.role <> 'super_admin' then raise exception 'Only QA can reopen appeals' using errcode = '42501'; end if;
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

create or replace function public.close_appeal(p_appeal uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null then raise exception 'Appeal not found'; end if;
  if me.role = 'super_admin' then
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

-- ---------------------------------------------------------------------------
-- Weekly reports: working link; also notify for weeks that arrive already
-- published (import) and for audits added to a published week later.
-- ---------------------------------------------------------------------------
create or replace function public.on_period_published()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    if new.published_at is null then new.published_at := now(); end if;
    for r in select distinct e.cam_id from public.evaluations e where e.period_id = new.id loop
      perform public.notify(r.cam_id, 'report_published', 'Your QA report for ' || new.short_label || ' is available',
        'Your weekly CS QA report for ' || new.label || ' has been published.', '/?mode=week&period=' || new.id, null);
    end loop;
  end if;
  return new;
end $$;

create or replace function public.on_evaluations_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select distinct n.cam_id, rp.id as period_id, rp.label, rp.short_label
    from new_rows n join public.reporting_periods rp on rp.id = n.period_id
    where rp.status = 'published'
      -- only recent weeks: back-filling archive audits (even into newly created, published
      -- historical weeks) must not flood CAMs with notifications for old reports
      and rp.published_at >= now() - interval '14 days'
      and rp.end_date >= current_date - 21
      and not exists (select 1 from public.notifications x
                      where x.recipient_id = n.cam_id and x.type = 'report_published'
                        and x.link like '%period=' || rp.id::text)
  loop
    perform public.notify(r.cam_id, 'report_published', 'Your QA report for ' || r.short_label || ' is available',
      'Your weekly CS QA report for ' || r.label || ' has been published.', '/?mode=week&period=' || r.period_id, null);
  end loop;
  return null;
end $$;
drop trigger if exists evaluations_report_notify on public.evaluations;
create trigger evaluations_report_notify after insert on public.evaluations
  referencing new table as new_rows for each statement execute function public.on_evaluations_added();

-- Fix links in notifications already sent.
update public.notifications set link = replace(link, '/dashboard?period=', '/?mode=week&period=')
 where link like '/dashboard?period=%';

-- Week status may only change through set_period_status / scheduled publishing.
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
  end if;
  return new;
end $$;
drop trigger if exists reporting_periods_guard on public.reporting_periods;
create trigger reporting_periods_guard before insert or update on public.reporting_periods
  for each row execute function public.guard_period_status();

-- Scheduled publishing: a per-week auto_publish_at wins; otherwise, when
-- reporting.auto_publish is on, a draft week publishes on the first
-- auto_publish_dow (ISO 1=Mon … 7=Sun) after it ends, at auto_publish_time
-- in reporting.timezone.
create or replace function public.period_auto_publish_due(p public.reporting_periods)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  cfg jsonb := coalesce(public.get_setting('reporting'), '{}'::jsonb);
  v_dow int := coalesce((cfg ->> 'auto_publish_dow')::int, 1);
  v_time time := coalesce(nullif(cfg ->> 'auto_publish_time', '')::time, '10:00');
  v_tz text := coalesce(nullif(cfg ->> 'timezone', ''), 'UTC');
  v_day date;
begin
  if p.auto_publish_at is not null then return p.auto_publish_at; end if;
  if not coalesce((cfg ->> 'auto_publish')::boolean, false) then return null; end if;
  select d::date into v_day from generate_series((p.end_date + 1)::timestamp, (p.end_date + 7)::timestamp, interval '1 day') d
   where extract(isodow from d) = v_dow limit 1;
  return (v_day + v_time) at time zone v_tz;
end $$;

create or replace function public.publish_due_periods()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.is_service_role() or public.is_super_admin() or session_user = 'postgres') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.reporting_periods rp set status = 'published', published_at = now()
   where rp.status = 'draft' and public.period_auto_publish_due(rp) <= now()
     and exists (select 1 from public.evaluations e where e.period_id = rp.id);
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- SLA sweep: "due soon" (within 1 day) and "overdue" reminders, once per status.
-- ---------------------------------------------------------------------------
create or replace function public.appeal_sla_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record; n int := 0; v_to uuid; v_due timestamptz; v_type text;
  sla jsonb := coalesce(public.get_setting('sla'), '{}'::jsonb);
begin
  if not (public.is_service_role() or public.is_super_admin() or session_user = 'postgres') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  for r in select * from public.v_appeals
           where status in ('pending_lead_review', 'pending_qa_review', 'returned_to_cam', 'pending_additional_info') loop
    v_due := case
      when r.status = 'pending_lead_review' then r.status_changed_at + make_interval(days => coalesce((sla ->> 'lead_review_days')::int, 2))
      when r.status = 'pending_qa_review' then r.status_changed_at + make_interval(days => coalesce((sla ->> 'qa_review_days')::int, 3))
      else r.info_due_at end;
    if v_due is null then continue; end if;
    if now() > v_due then v_type := 'appeal_overdue';
    elsif now() > v_due - interval '1 day' then v_type := 'appeal_due_soon';
    else continue; end if;
    if exists (select 1 from public.notifications n2 where n2.appeal_id = r.id and n2.type = v_type
               and n2.created_at >= r.status_changed_at) then continue; end if;

    if r.status = 'pending_lead_review' then v_to := r.lead_id;
    elsif r.status = 'returned_to_cam' or (r.status = 'pending_additional_info' and r.info_requested_from = 'cam') then v_to := r.cam_id;
    elsif r.status = 'pending_additional_info' then v_to := r.lead_id;
    else v_to := null; end if;

    if v_to is null then
      perform public.notify_super_admins(v_type,
        'Appeal ' || r.reference || case when v_type = 'appeal_overdue' then ' is overdue' else ' is due soon' end,
        public._appeal_msg(r.id, case when v_type = 'appeal_overdue' then 'This appeal has exceeded its review target.'
          else 'This appeal reaches its review target on ' || to_char(v_due, 'DD Mon YYYY HH24:MI') || '.' end),
        '/appeals/' || r.id, r.id);
    else
      perform public.notify(v_to, v_type,
        'Appeal ' || r.reference || case when v_type = 'appeal_overdue' then ' is overdue' else ' is due soon' end,
        public._appeal_msg(r.id, case when v_type = 'appeal_overdue' then 'This appeal has exceeded its review target.'
          else 'Action is needed by ' || to_char(v_due, 'DD Mon YYYY HH24:MI') || '.' end),
        '/appeals/' || r.id, r.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Audit log: every appeal action with its reason; item decisions.
-- ---------------------------------------------------------------------------
drop trigger if exists audit_appeals on public.appeals;
create or replace function public.audit_appeal_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value, reason)
  values (new.actor_id, 'appeal_' || new.action, 'appeals', new.appeal_id::text,
          case when new.from_status is not null then jsonb_build_object('status', new.from_status) end,
          jsonb_strip_nulls(jsonb_build_object('status', new.to_status, 'recommendation', new.recommendation,
            'visibility', new.visibility, 'reference', (select reference from public.appeals where id = new.appeal_id))),
          new.comment);
  return new;
end $$;
drop trigger if exists audit_appeal_events on public.appeal_events;
create trigger audit_appeal_events after insert on public.appeal_events
  for each row execute function public.audit_appeal_event();

create or replace function public.audit_appeal_item()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.decision is distinct from old.decision then
    insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value, reason)
    values (public.my_employee_id(), 'appeal_item_decision', 'appeal_items', new.id::text,
            jsonb_build_object('decision', old.decision, 'score', old.original_score),
            jsonb_build_object('decision', new.decision, 'revised_score', new.revised_score, 'appeal_id', new.appeal_id),
            new.decision_reason);
  end if;
  return new;
end $$;
drop trigger if exists audit_appeal_items on public.appeal_items;
create trigger audit_appeal_items after update on public.appeal_items
  for each row execute function public.audit_appeal_item();

-- ---------------------------------------------------------------------------
-- Server-side validation
-- ---------------------------------------------------------------------------
create or replace function public.validate_setting()
returns trigger language plpgsql as $$
declare v jsonb := new.value;
begin
  if new.key = 'thresholds' then
    if (v ->> 'green')::numeric not between 0 and 100 or (v ->> 'amber')::numeric not between 0 and 100
       or (v ->> 'amber')::numeric > (v ->> 'green')::numeric then
      raise exception 'Thresholds must be between 0 and 100, with amber at or below green';
    end if;
  elsif new.key = 'qa_target' then
    if (v ->> 'score')::numeric not between 0 and 100 then raise exception 'QA target must be between 0 and 100'; end if;
  elsif new.key = 'appeal_window' then
    if (v ->> 'days')::int < 0 or coalesce((v ->> 'max_appeals_per_cam_per_period')::int, 1) < 1 then
      raise exception 'Appeal window days must be 0 or more and the weekly limit at least 1';
    end if;
  elsif new.key = 'sla' then
    if least((v ->> 'lead_review_days')::int, (v ->> 'qa_review_days')::int, (v ->> 'clarification_days')::int) < 0 then
      raise exception 'Service-level days cannot be negative';
    end if;
  elsif new.key = 'reporting' then
    if (v ->> 'week_start_dow')::int not between 1 and 7 or coalesce((v ->> 'auto_publish_dow')::int, 1) not between 1 and 7 then
      raise exception 'Days of the week must be 1 (Monday) to 7 (Sunday)';
    end if;
    perform now() at time zone coalesce(nullif(v ->> 'timezone', ''), 'UTC');
    perform nullif(v ->> 'auto_publish_time', '')::time;
  elsif new.key = 'notifications' then
    if coalesce(v ->> 'portal_url', '') <> '' and (v ->> 'portal_url') !~ '^https?://' then
      raise exception 'Portal URL must start with http:// or https://';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists settings_validate on public.settings;
create trigger settings_validate before insert or update on public.settings
  for each row execute function public.validate_setting();

-- Team leads must be active Admins (or QA Super Admins).
create or replace function public.validate_team_lead()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is not null and not exists (
    select 1 from public.employees where id = new.lead_id and role in ('admin', 'super_admin') and status = 'active') then
    raise exception 'A Team Lead must be an active Admin (Team Lead) account';
  end if;
  return new;
end $$;
drop trigger if exists teams_validate_lead on public.teams;
create trigger teams_validate_lead before insert or update of lead_id on public.teams
  for each row execute function public.validate_team_lead();

-- Employees: keep at least one active Super Admin; QA cannot demote or deactivate themselves.
create or replace function public.guard_employee_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_me uuid := public.my_employee_id();
begin
  if tg_op = 'DELETE' then
    if old.role = 'super_admin' and old.status = 'active' and not exists (
      select 1 from public.employees where role = 'super_admin' and status = 'active' and id <> old.id) then
      raise exception 'The last active Super Admin cannot be removed';
    end if;
    return old;
  end if;
  if old.role = 'super_admin' and old.status = 'active' and (new.role <> 'super_admin' or new.status <> 'active') then
    if v_me is not null and v_me = old.id then
      raise exception 'You cannot remove your own Super Admin access. Ask another Super Admin.';
    end if;
    if not exists (select 1 from public.employees where role = 'super_admin' and status = 'active' and id <> old.id) then
      raise exception 'The last active Super Admin cannot be demoted or deactivated';
    end if;
  end if;
  if old.role in ('admin', 'super_admin') and new.role = 'user'
     and exists (select 1 from public.teams where lead_id = old.id) then
    raise exception 'This person leads a team. Assign another Team Lead first.';
  end if;
  return new;
end $$;
drop trigger if exists employees_guard on public.employees;
create trigger employees_guard before update or delete on public.employees
  for each row execute function public.guard_employee_change();

-- ---------------------------------------------------------------------------
-- Privileges for new functions
-- ---------------------------------------------------------------------------
-- Internal helpers and trigger functions: not callable through the API.
revoke execute on function public._appeal_msg(uuid, text), public._insert_appeal_items(uuid, uuid, jsonb),
  public._check_appeal_limit(uuid, uuid, uuid), public.period_auto_publish_due(public.reporting_periods),
  public.on_evaluations_added(), public.guard_period_status(), public.audit_appeal_event(), public.audit_appeal_item(),
  public.validate_setting(), public.validate_team_lead(), public.guard_employee_change()
  from public, anon, authenticated;
revoke execute on function public.update_draft_appeal(uuid, text, jsonb), public.share_appeal_comment(uuid) from public, anon;
grant execute on function public.update_draft_appeal(uuid, text, jsonb), public.share_appeal_comment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Report downloads are recorded in the audit log.
-- ---------------------------------------------------------------------------
create or replace function public.log_report_export(p_scope text, p_period text, p_format text)
returns void language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me();
begin
  if p_format not in ('pdf', 'xlsx', 'csv') then raise exception 'Unknown format'; end if;
  insert into public.audit_logs (actor_id, action, table_name, record_id, new_value)
  values (me.id, 'report_export', null, null,
          jsonb_build_object('scope', left(p_scope, 200), 'period', left(p_period, 100), 'format', p_format, 'role', me.role));
end $$;
revoke execute on function public.log_report_export(text, text, text) from public, anon;
grant execute on function public.log_report_export(text, text, text) to authenticated;
