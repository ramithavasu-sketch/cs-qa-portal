-- =============================================================================
-- Workflow RPCs (appeals, score adjustments, publishing, imports) + triggers.
-- Every state change goes through a SECURITY DEFINER function that checks the
-- caller's role and the current appeal status, so the Lead-first sequence
-- cannot be bypassed via the API.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Small utilities
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger employees_touch before update on public.employees for each row execute function public.touch_updated_at();
create trigger teams_touch before update on public.teams for each row execute function public.touch_updated_at();
create trigger appeals_touch before update on public.appeals for each row execute function public.touch_updated_at();

create or replace function public.add_business_days(p_from timestamptz, p_days int)
returns timestamptz language plpgsql immutable as $$
declare
  d timestamptz := p_from;
  added int := 0;
begin
  if p_days <= 0 then return p_from; end if;
  while added < p_days loop
    d := d + interval '1 day';
    if extract(isodow from d) < 6 then added := added + 1; end if;
  end loop;
  return d;
end $$;

create or replace function public.add_days_setting(p_from timestamptz, p_days int, p_business boolean)
returns timestamptz language sql immutable as $$
  select case when p_business then public.add_business_days(p_from, p_days)
              else p_from + make_interval(days => p_days) end
$$;

-- Appeal deadline for an evaluation = period publication + configured window.
create or replace function public.appeal_deadline(p_evaluation uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select public.add_days_setting(
           rp.published_at,
           coalesce((public.get_setting('appeal_window') ->> 'days')::int, 5),
           coalesce((public.get_setting('appeal_window') ->> 'business_days')::boolean, true))
  from public.evaluations e
  join public.reporting_periods rp on rp.id = e.period_id
  where e.id = p_evaluation and rp.status = 'published'
$$;

create or replace function public._me()
returns public.employees language plpgsql stable security definer set search_path = public as $$
declare r public.employees;
begin
  select * into r from public.employees where auth_user_id = auth.uid() and status = 'active';
  if r.id is null then
    raise exception 'Not authorised: no active portal account for this login' using errcode = '42501';
  end if;
  return r;
end $$;

-- Queue an in-app notification (+ optional email). Email bodies deliberately
-- exclude scores/feedback: only reference, task id, status and a portal link.
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
  if coalesce((cfg -> 'in_app' ->> p_type)::boolean, true) = false then return; end if;
  insert into public.notifications (recipient_id, type, title, message, link, appeal_id)
  values (p_recipient, p_type, p_title, p_message, p_link, p_appeal);
  if coalesce((cfg ->> 'email_enabled')::boolean, false)
     and coalesce((cfg -> 'email' ->> p_type)::boolean, true) then
    insert into public.email_outbox (recipient_email, subject, body_text)
    values (emp.email, '[CS QA Portal] ' || p_title,
            p_message || E'\n\nOpen the portal to view details: ' ||
            coalesce(cfg ->> 'portal_url', '') || coalesce(p_link, '') ||
            E'\n\nThis message is confidential and intended only for the recipient.');
  end if;
end $$;

create or replace function public.notify_super_admins(p_type text, p_title text, p_message text, p_link text, p_appeal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.employees where role = 'super_admin' and status = 'active' loop
    perform public.notify(r.id, p_type, p_title, p_message, p_link, p_appeal);
  end loop;
end $$;

create or replace function public._appeal_event(
  p_appeal uuid, p_actor public.employees, p_action text, p_comment text,
  p_visibility public.comment_visibility, p_from public.appeal_status, p_to public.appeal_status,
  p_recommendation public.lead_recommendation default null)
returns void language sql security definer set search_path = public as $$
  insert into public.appeal_events (appeal_id, actor_id, actor_role, action, recommendation, comment, visibility, from_status, to_status)
  values (p_appeal, p_actor.id, p_actor.role, p_action, p_recommendation, nullif(trim(p_comment), ''), p_visibility, p_from, p_to);
$$;

create or replace function public._set_appeal_status(p_appeal uuid, p_status public.appeal_status)
returns void language sql security definer set search_path = public as $$
  update public.appeals set status = p_status, status_changed_at = now() where id = p_appeal;
$$;

-- Current effective value of a parameter / autofail flag for an evaluation.
create or replace function public._effective_param(p_eval uuid, p_param uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sa.revised_value from public.score_adjustments sa
      where sa.evaluation_id = p_eval and sa.kind = 'parameter' and sa.parameter_id = p_param
      order by sa.created_at desc, sa.id desc limit 1),
    (select s.earned from public.evaluation_scores s where s.evaluation_id = p_eval and s.parameter_id = p_param))
$$;

create or replace function public._effective_autofail(p_eval uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sa.revised_value = 1 from public.score_adjustments sa
      where sa.evaluation_id = p_eval and sa.kind = 'autofail'
      order by sa.created_at desc, sa.id desc limit 1),
    (select e.autofail from public.evaluations e where e.id = p_eval))
$$;

-- ---------------------------------------------------------------------------
-- CAM: submit appeal (or save a draft)
-- p_items: [{ "parameter_id": uuid } | { "is_autofail": true }, "requested_score": num? ]
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
  it jsonb;
  v_param uuid;
  v_is_af boolean;
  v_req numeric;
  v_max numeric;
  v_orig numeric;
  v_grant uuid;
  v_limit int;
  v_count int;
  v_seen text[] := '{}';
  v_key text;
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
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one disputed parameter';
  end if;

  select t.lead_id into v_lead from public.teams t where t.id = me.team_id;
  if v_lead is null then
    raise exception 'No Team Lead is assigned to your team. Please contact the QA team.';
  end if;

  v_limit := (public.get_setting('appeal_window') ->> 'max_appeals_per_cam_per_period')::int;
  if v_limit is not null and not p_as_draft then
    select count(*) into v_count
    from public.appeals a join public.evaluations e2 on e2.id = a.evaluation_id
    where a.cam_id = me.id and e2.period_id = ev.period_id and a.status not in ('draft', 'closed');
    if v_count >= v_limit then
      raise exception 'You have reached the maximum of % appeal(s) for this audit week', v_limit;
    end if;
  end if;

  v_ref := 'APL-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.appeal_ref_seq')::text, 5, '0');
  insert into public.appeals (reference, evaluation_id, cam_id, lead_id, status, reason, submitted_at, is_demo)
  values (v_ref, ev.id, me.id, v_lead, v_status, trim(p_reason),
          case when p_as_draft then null else now() end, ev.is_demo)
  returning id into v_appeal;

  for it in select * from jsonb_array_elements(p_items) loop
    v_is_af := coalesce((it ->> 'is_autofail')::boolean, false);
    v_param := nullif(it ->> 'parameter_id', '')::uuid;
    v_req := nullif(it ->> 'requested_score', '')::numeric;
    v_key := case when v_is_af then 'AF' else coalesce(v_param::text, '') end;
    if v_key = any (v_seen) then raise exception 'The same parameter was selected twice'; end if;
    v_seen := v_seen || v_key;

    if v_is_af then
      if not public._effective_autofail(ev.id) then
        raise exception 'This evaluation is not marked as an autofail';
      end if;
      v_orig := 1; v_max := 1; v_param := null;
    else
      select s.max_score into v_max from public.evaluation_scores s
      where s.evaluation_id = ev.id and s.parameter_id = v_param;
      if v_max is null then
        raise exception 'Parameter % is not part of this evaluation', coalesce(v_param::text, '(missing)');
      end if;
      v_orig := public._effective_param(ev.id, v_param);
      if v_req is not null and (v_req < 0 or v_req > v_max) then
        raise exception 'Requested score must be between 0 and %', v_max;
      end if;
    end if;

    -- Duplicate protection: any non-withdrawn appeal on the same task + parameter blocks,
    -- unless QA has granted a resubmission.
    if exists (
      select 1 from public.appeal_items ai join public.appeals a on a.id = ai.appeal_id
      where a.evaluation_id = ev.id and a.id <> v_appeal
        and (a.status <> 'closed' or a.decided_at is not null)
        and ai.is_autofail = v_is_af
        and (ai.parameter_id is not distinct from v_param)
    ) then
      select g.id into v_grant from public.appeal_resubmission_grants g
      where g.evaluation_id = ev.id and g.used_at is null and g.is_autofail = v_is_af
        and g.parameter_id is not distinct from v_param
      order by g.created_at limit 1;
      if v_grant is null then
        raise exception 'An appeal for this task and parameter already exists';
      end if;
      update public.appeal_resubmission_grants set used_at = now() where id = v_grant;
    end if;

    insert into public.appeal_items (appeal_id, parameter_id, is_autofail, original_score, requested_score)
    values (v_appeal, v_param, v_is_af, v_orig, case when v_is_af then 0 else v_req end);
  end loop;

  perform public._appeal_event(v_appeal, me, case when p_as_draft then 'draft_saved' else 'submitted' end,
                               null, 'shared', null, v_status);
  if not p_as_draft then
    perform public.notify(v_lead, 'appeal_submitted', 'New appeal ' || v_ref || ' awaiting your review',
      'Appeal ' || v_ref || ' for task ' || ev.task_id || ' is pending Lead review.',
      '/appeals/' || v_appeal, v_appeal);
  end if;
  return v_appeal;
end $$;

create or replace function public.submit_draft_appeal(p_appeal uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  a public.appeals;
  v_lead uuid;
begin
  select * into a from public.appeals where id = p_appeal for update;
  if a.id is null or a.cam_id <> me.id then raise exception 'Not authorised' using errcode = '42501'; end if;
  if a.status <> 'draft' then raise exception 'Only drafts can be submitted'; end if;
  if now() > public.appeal_deadline(a.evaluation_id) then raise exception 'The appeal window has closed'; end if;
  select t.lead_id into v_lead from public.teams t where t.id = me.team_id;
  if v_lead is null then raise exception 'No Team Lead is assigned to your team. Please contact the QA team.'; end if;
  update public.appeals set lead_id = v_lead, submitted_at = now() where id = p_appeal;
  perform public._set_appeal_status(p_appeal, 'pending_lead_review');
  perform public._appeal_event(p_appeal, me, 'submitted', null, 'shared', 'draft', 'pending_lead_review');
  perform public.notify(v_lead, 'appeal_submitted', 'New appeal ' || a.reference || ' awaiting your review',
    'Appeal ' || a.reference || ' is pending Lead review.', '/appeals/' || p_appeal, p_appeal);
end $$;

-- ---------------------------------------------------------------------------
-- Team Lead review: forward to QA with a recommendation, or return to CAM.
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
      'Your Team Lead has requested more information on appeal ' || a.reference || '.',
      '/appeals/' || p_appeal, p_appeal);
  else
    update public.appeals set lead_recommendation = p_recommendation, forwarded_at = now(),
      info_requested_from = null, info_due_at = null where id = p_appeal;
    perform public._set_appeal_status(p_appeal, 'pending_qa_review');
    perform public._appeal_event(p_appeal, me, 'lead_forwarded', p_comment, 'shared',
                                 'pending_lead_review', 'pending_qa_review', p_recommendation);
    perform public.notify_super_admins('appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      'Appeal ' || a.reference || ' has been reviewed by the Team Lead and is pending QA review.',
      '/appeals/' || p_appeal, p_appeal);
    perform public.notify(a.cam_id, 'appeal_forwarded', 'Appeal ' || a.reference || ' forwarded to QA',
      'Your appeal ' || a.reference || ' has been reviewed by your Team Lead and forwarded to QA.',
      '/appeals/' || p_appeal, p_appeal);
  end if;
end $$;

-- CAM or Lead answers a clarification request.
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
      'The CAM has provided the requested information for appeal ' || a.reference || '.', '/appeals/' || p_appeal, p_appeal);
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
      'Requested information has been provided for appeal ' || a.reference || '.', '/appeals/' || p_appeal, p_appeal);
  else
    raise exception 'No information has been requested on this appeal';
  end if;
end $$;

create or replace function public.add_appeal_comment(p_appeal uuid, p_comment text, p_internal boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me();
begin
  if not public.can_view_appeal(p_appeal) then raise exception 'Not authorised' using errcode = '42501'; end if;
  if p_internal and me.role = 'user' then raise exception 'CAMs cannot add internal comments' using errcode = '42501'; end if;
  if p_comment is null or length(trim(p_comment)) < 2 then raise exception 'Comment is empty'; end if;
  perform public._appeal_event(p_appeal, me, 'comment', p_comment,
    case when p_internal then 'internal'::public.comment_visibility else 'shared'::public.comment_visibility end, null, null);
end $$;

-- ---------------------------------------------------------------------------
-- QA (Super Admin)
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
    'QA needs additional information to decide appeal ' || a.reference || '.', '/appeals/' || p_appeal, p_appeal);
end $$;

-- p_decisions: [{ "item_id": uuid, "decision": "approved"|"rejected", "revised_score": num?, "reason": text? }]
-- p_extra_adjustments: [{ "parameter_id": uuid, "revised_score": num, "reason": text }]
--   (used e.g. when an autofail is overturned but other parameters are marked down)
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

    if v_dec = 'approved' then
      v_approved := v_approved + 1;
      if it.is_autofail then
        v_cur := case when public._effective_autofail(ev.id) then 1 else 0 end;
        v_rev := 0;
        if v_cur <> 0 then
          insert into public.score_adjustments (evaluation_id, kind, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
          values (ev.id, 'autofail', v_cur, 0, coalesce(nullif(trim(d ->> 'reason'), ''), trim(p_resolution)), p_appeal, it.id, me.id);
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
        insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, appeal_id, appeal_item_id, approved_by)
        values (ev.id, 'parameter', it.parameter_id, coalesce(v_cur, 0), v_rev,
                coalesce(nullif(trim(d ->> 'reason'), ''), trim(p_resolution)), p_appeal, it.id, me.id);
      end if;
    else
      v_rejected := v_rejected + 1;
      v_rev := null;
      -- Reopened appeal previously approved: restore the original value.
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
           decision_reason = coalesce(nullif(trim(d ->> 'reason'), ''), trim(p_resolution)),
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
    'QA has made a final decision on appeal ' || a.reference || ' (' || replace(v_final::text, '_', ' ') || ').',
    '/appeals/' || p_appeal, p_appeal);
  perform public.notify(a.lead_id, 'appeal_decided', 'Decision on appeal ' || a.reference,
    'QA has made a final decision on appeal ' || a.reference || ' (' || replace(v_final::text, '_', ' ') || ').',
    '/appeals/' || p_appeal, p_appeal);
  if v_approved > 0 then
    perform public.notify(a.cam_id, 'score_changed', 'Score updated for task ' || ev.task_id,
      'A finalized score was changed following appeal ' || a.reference || '.', '/evaluations/' || ev.id, p_appeal);
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
  update public.appeal_items set decision = 'pending' where appeal_id = p_appeal;
  perform public._set_appeal_status(p_appeal, 'pending_qa_review');
  perform public._appeal_event(p_appeal, me, 'qa_reopened', p_reason, 'shared', a.status, 'pending_qa_review');
  perform public.notify(a.cam_id, 'appeal_reopened', 'Appeal ' || a.reference || ' reopened',
    'QA has reopened appeal ' || a.reference || ' for further review.', '/appeals/' || p_appeal, p_appeal);
  perform public.notify(a.lead_id, 'appeal_reopened', 'Appeal ' || a.reference || ' reopened',
    'QA has reopened appeal ' || a.reference || ' for further review.', '/appeals/' || p_appeal, p_appeal);
end $$;

-- CAM withdraws (before QA stage) or QA closes.
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
      'Appeal ' || a.reference || ' has been closed.', '/appeals/' || p_appeal, p_appeal);
  end if;
end $$;

create or replace function public.grant_appeal_resubmission(p_evaluation uuid, p_parameter uuid, p_is_autofail boolean, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me(); v_id uuid;
begin
  if me.role <> 'super_admin' then raise exception 'Only QA can grant resubmissions' using errcode = '42501'; end if;
  if p_reason is null or length(trim(p_reason)) < 5 then raise exception 'A reason is required'; end if;
  insert into public.appeal_resubmission_grants (evaluation_id, parameter_id, is_autofail, granted_by, reason)
  values (p_evaluation, case when p_is_autofail then null else p_parameter end, p_is_autofail, me.id, trim(p_reason))
  returning id into v_id;
  return v_id;
end $$;

-- Direct QA score correction outside an appeal (always logged, original kept).
create or replace function public.admin_adjust_score(p_evaluation uuid, p_parameter uuid, p_revised numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  ev public.evaluations;
  v_max numeric;
  v_cur numeric;
begin
  if me.role <> 'super_admin' then raise exception 'Only QA Super Admins can change finalized scores' using errcode = '42501'; end if;
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

-- ---------------------------------------------------------------------------
-- Reporting periods: publish / unpublish (notifications fire from a trigger)
-- ---------------------------------------------------------------------------
create or replace function public.set_period_status(p_period uuid, p_status public.period_status)
returns void language plpgsql security definer set search_path = public as $$
declare me public.employees := public._me();
begin
  if me.role <> 'super_admin' then raise exception 'Only QA can publish reports' using errcode = '42501'; end if;
  update public.reporting_periods
     set status = p_status,
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end,
         published_by = case when p_status = 'published' then me.id else published_by end
   where id = p_period;
end $$;

create or replace function public.on_period_published()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    if new.published_at is null then new.published_at := now(); end if;
    for r in select distinct e.cam_id from public.evaluations e where e.period_id = new.id loop
      perform public.notify(r.cam_id, 'report_published', 'Your QA report for ' || new.short_label || ' is available',
        'Your weekly CS QA report for ' || new.label || ' has been published.', '/dashboard?period=' || new.id, null);
    end loop;
  end if;
  return new;
end $$;
create trigger reporting_periods_publish before update on public.reporting_periods
  for each row execute function public.on_period_published();

-- Called by pg_cron / scheduled Edge Function.
create or replace function public.publish_due_periods()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.is_service_role() or public.is_super_admin() or session_user = 'postgres') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  update public.reporting_periods set status = 'published', published_at = now()
   where status = 'draft' and auto_publish_at is not null and auto_publish_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- SLA reminders: warns the current owner once per status when an appeal is overdue.
create or replace function public.appeal_sla_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_to uuid;
begin
  if not (public.is_service_role() or public.is_super_admin() or session_user = 'postgres') then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  for r in select * from public.v_appeals where overdue loop
    if exists (select 1 from public.notifications n2 where n2.appeal_id = r.id and n2.type = 'appeal_overdue'
               and n2.created_at >= r.status_changed_at) then continue; end if;
    if r.status = 'pending_lead_review' then v_to := r.lead_id;
    elsif r.status = 'returned_to_cam' or (r.status = 'pending_additional_info' and r.info_requested_from = 'cam') then v_to := r.cam_id;
    elsif r.status = 'pending_additional_info' then v_to := r.lead_id;
    else v_to := null; end if;
    if v_to is null then
      perform public.notify_super_admins('appeal_overdue', 'Appeal ' || r.reference || ' is overdue',
        'Appeal ' || r.reference || ' has exceeded its review target.', '/appeals/' || r.id, r.id);
    else
      perform public.notify(v_to, 'appeal_overdue', 'Appeal ' || r.reference || ' is overdue',
        'Appeal ' || r.reference || ' has exceeded its review target.', '/appeals/' || r.id, r.id);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language sql security definer set search_path = public as $$
  update public.notifications set read_at = now()
   where recipient_id = public.my_employee_id() and read_at is null
     and (p_ids is null or id = any (p_ids));
$$;

-- ---------------------------------------------------------------------------
-- Import. Rows are pre-mapped by the shared TypeScript mapper
-- (supabase/functions/_shared/mapper.ts) and validated again here.
-- p_payload: { batch_id?, source, file_name, publish_new_periods: bool, rows: [...] }
-- row: { row_number, task_link, task_id, cam_email, cam_name, lead_name, evaluator_email, evaluator_name,
--        task_type, request_from, task_loaded_date, audited_at, period:{label,short_label,year,week,start,end},
--        task_seq, connection_id, screenshot_url, autofail, fcr, score, feedback,
--        scores:[{parameter_id, earned}] }
-- ---------------------------------------------------------------------------
create or replace function public.import_evaluations(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := public.my_employee_id();
  v_batch uuid := nullif(p_payload ->> 'batch_id', '')::uuid;
  r jsonb;
  s jsonb;
  v_cam uuid;
  v_period uuid;
  v_eval uuid;
  v_eval_by uuid;
  v_team uuid;
  v_sum numeric;
  v_max numeric;
  v_missing int;
  v_ins int := 0; v_dup int := 0; v_rej int := 0; v_total int := 0;
  v_reason text;
  v_nver int; v_ver text; v_unknown int;
  v_publish boolean := coalesce((p_payload ->> 'publish_new_periods')::boolean, false);
begin
  if not (public.is_super_admin() or public.is_service_role()) then
    raise exception 'Only QA Super Admins can import evaluations' using errcode = '42501';
  end if;
  if v_batch is null then
    insert into public.import_batches (source, file_name, uploaded_by)
    values (coalesce(p_payload ->> 'source', 'csv'), p_payload ->> 'file_name', v_actor)
    returning id into v_batch;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'rows', '[]'::jsonb)) loop
    v_total := v_total + 1;
    v_reason := null;
    begin
      if coalesce(r ->> 'task_link', '') !~ '^https?://' then v_reason := 'Missing or invalid DS Task Link'; end if;
      if v_reason is null and coalesce(r ->> 'cam_email', '') <> '' and (r ->> 'cam_email') !~ '^[^@\s]+@[^@\s]+$' then v_reason := 'Invalid CAM email'; end if;
      if v_reason is null and coalesce(r ->> 'cam_email', '') = '' and coalesce(trim(r ->> 'cam_name'), '') = '' then v_reason := 'CAM email or name is required'; end if;
      if v_reason is null and not exists (select 1 from public.task_types where code = r ->> 'task_type') then
        v_reason := 'Unknown task type'; end if;
      if v_reason is null and (r -> 'period' ->> 'label') is null then v_reason := 'Missing QA Week'; end if;
      if v_reason is null and ((r ->> 'score') is null or (r ->> 'score')::numeric not between 0 and 100) then
        v_reason := 'Score missing or outside 0-100'; end if;
      if v_reason is null and coalesce((r ->> 'autofail')::boolean, false) and (r ->> 'score')::numeric <> 0 then
        v_reason := 'Autofail = Yes but score is not 0'; end if;
      if v_reason is null then
        -- all scores must belong to this task type and to ONE rubric version, and that version must be complete
        select count(distinct p.rubric_version), min(p.rubric_version), count(*) filter (where p.id is null)
          into v_nver, v_ver, v_unknown
        from jsonb_array_elements(coalesce(r -> 'scores', '[]'::jsonb)) x
        left join public.evaluation_parameters p on p.id = (x ->> 'parameter_id')::uuid and p.task_type = r ->> 'task_type';
        if v_unknown > 0 then v_reason := 'Scores refer to parameters of another task type';
        elsif v_nver <> 1 then v_reason := 'Scores must come from exactly one rubric version';
        else
          select count(*) into v_missing
          from public.evaluation_parameters p
          where p.task_type = r ->> 'task_type' and p.rubric_version = v_ver and (v_ver <> 'current' or p.active)
            and not exists (select 1 from jsonb_array_elements(r -> 'scores') x where (x ->> 'parameter_id')::uuid = p.id);
          if v_missing > 0 then v_reason := v_missing || ' scoring parameter(s) missing for this task type'; end if;
        end if;
      end if;
      if v_reason is null then
        select sum((x ->> 'earned')::numeric), sum(p.max_score) filter (where x ->> 'earned' is not null)
          into v_sum, v_max
        from jsonb_array_elements(r -> 'scores') x
        join public.evaluation_parameters p on p.id = (x ->> 'parameter_id')::uuid and p.task_type = r ->> 'task_type';
        if exists (select 1 from jsonb_array_elements(r -> 'scores') x
                   join public.evaluation_parameters p on p.id = (x ->> 'parameter_id')::uuid
                   where (x ->> 'earned') is not null and ((x ->> 'earned')::numeric < 0 or (x ->> 'earned')::numeric > p.max_score)) then
          v_reason := 'A parameter score is outside its allowed range';
        elsif not coalesce((r ->> 'autofail')::boolean, false) and v_max > 0
              and round(100 * v_sum / v_max, 2) <> round((r ->> 'score')::numeric, 2) then
          v_reason := 'Score ' || (r ->> 'score') || ' does not match the parameter total ' || round(100 * v_sum / v_max, 2);
        end if;
      end if;

      if v_reason is not null then
        v_rej := v_rej + 1;
        insert into public.import_rejections (batch_id, row_number, reason, raw) values (v_batch, (r ->> 'row_number')::int, v_reason, r);
        continue;
      end if;

      -- CAM (auto-create; can log in once invited)
      if coalesce(r ->> 'cam_email', '') = '' then
        v_cam := public._resolve_cam_name(r ->> 'cam_name', coalesce((p_payload ->> 'is_demo')::boolean, false));
      else
        select id into v_cam from public.employees where email = lower(r ->> 'cam_email');
      end if;
      if v_cam is null then
        insert into public.employees (email, full_name, role, status, is_demo)
        values (lower(r ->> 'cam_email'), coalesce(nullif(r ->> 'cam_name', ''), split_part(r ->> 'cam_email', '@', 1)), 'user', 'active',
                coalesce((p_payload ->> 'is_demo')::boolean, false))
        returning id into v_cam;
      end if;
      -- Team from "Lead Name" (only when the CAM has no team yet)
      if nullif(r ->> 'lead_name', '') is not null and (select team_id from public.employees where id = v_cam) is null then
        select t.id into v_team from public.teams t join public.employees l on l.id = t.lead_id
        where lower(l.full_name) = lower(trim(r ->> 'lead_name')) limit 1;
        if v_team is not null then update public.employees set team_id = v_team where id = v_cam; end if;
      end if;
      select id into v_eval_by from public.employees where email = lower(coalesce(r ->> 'evaluator_email', ''));

      select id into v_period from public.reporting_periods where label = r -> 'period' ->> 'label';
      if v_period is null then
        insert into public.reporting_periods (label, short_label, year, week_number, start_date, end_date, status, published_at, is_demo)
        values (r -> 'period' ->> 'label', r -> 'period' ->> 'short_label', (r -> 'period' ->> 'year')::int,
                (r -> 'period' ->> 'week')::int, (r -> 'period' ->> 'start')::date, (r -> 'period' ->> 'end')::date,
                case when v_publish then 'published'::public.period_status else 'draft'::public.period_status end,
                case when v_publish then now() end, coalesce((p_payload ->> 'is_demo')::boolean, false))
        returning id into v_period;
      end if;

      insert into public.evaluations (task_id, task_link, cam_id, evaluator_id, evaluator_email, evaluator_name, task_type,
        request_from, task_loaded_date, audited_at, period_id, task_seq, connection_id, screenshot_url, autofail, fcr,
        original_score, feedback, lead_name_at_audit, import_batch_id, is_demo)
      values (coalesce(nullif(r ->> 'task_id', ''), r ->> 'task_link'), r ->> 'task_link', v_cam, v_eval_by,
        lower(nullif(r ->> 'evaluator_email', '')), nullif(r ->> 'evaluator_name', ''), r ->> 'task_type',
        nullif(r ->> 'request_from', ''), nullif(r ->> 'task_loaded_date', '')::date, (r ->> 'audited_at')::timestamptz,
        v_period, nullif(r ->> 'task_seq', ''), nullif(r ->> 'connection_id', ''), nullif(r ->> 'screenshot_url', ''),
        coalesce((r ->> 'autofail')::boolean, false), nullif(r ->> 'fcr', ''), (r ->> 'score')::numeric,
        nullif(r ->> 'feedback', ''), nullif(r ->> 'lead_name', ''), v_batch, coalesce((p_payload ->> 'is_demo')::boolean, false))
      on conflict on constraint evaluations_unique_audit do nothing
      returning id into v_eval;

      if v_eval is null then
        v_dup := v_dup + 1;
        continue;
      end if;
      for s in select * from jsonb_array_elements(r -> 'scores') loop
        insert into public.evaluation_scores (evaluation_id, parameter_id, earned, max_score)
        select v_eval, p.id, nullif(s ->> 'earned', '')::numeric, p.max_score
        from public.evaluation_parameters p where p.id = (s ->> 'parameter_id')::uuid;
      end loop;
      v_ins := v_ins + 1;
      v_eval := null;
    exception when others then
      v_rej := v_rej + 1;
      insert into public.import_rejections (batch_id, row_number, reason, raw)
      values (v_batch, (r ->> 'row_number')::int, 'Database error: ' || sqlerrm, r);
    end;
  end loop;

  update public.import_batches
     set total_rows = total_rows + v_total, inserted = inserted + v_ins,
         duplicates = duplicates + v_dup, rejected = rejected + v_rej
   where id = v_batch;
  insert into public.audit_logs (actor_id, action, table_name, record_id, new_value)
  values (v_actor, 'import', 'import_batches', v_batch::text,
          jsonb_build_object('rows', v_total, 'inserted', v_ins, 'duplicates', v_dup, 'rejected', v_rej));
  return jsonb_build_object('batch_id', v_batch, 'total', v_total, 'inserted', v_ins, 'duplicates', v_dup, 'rejected', v_rej);
end $$;

-- ---------------------------------------------------------------------------
-- Immutability of original evaluation data
-- ---------------------------------------------------------------------------
create or replace function public.block_evaluation_changes()
returns trigger language plpgsql as $$
begin
  if current_setting('app.allow_evaluation_purge', true) = 'on' and tg_op = 'DELETE' then
    return old;
  end if;
  -- merge_employee() may re-point an archived audit to the right CAM; nothing else may change
  if tg_op = 'UPDATE' and tg_table_name = 'evaluations' and current_setting('app.allow_cam_merge', true) = 'on'
     and (to_jsonb(new) - 'cam_id') = (to_jsonb(old) - 'cam_id') then
    return new;
  end if;
  raise exception 'Original evaluation records are immutable. Use a score adjustment instead.';
end $$;
create trigger evaluations_immutable before update or delete on public.evaluations
  for each row execute function public.block_evaluation_changes();
create trigger evaluation_scores_immutable before update or delete on public.evaluation_scores
  for each row execute function public.block_evaluation_changes();
create trigger score_adjustments_append_only before update or delete on public.score_adjustments
  for each row execute function public.block_evaluation_changes();

-- ---------------------------------------------------------------------------
-- Audit log triggers
-- ---------------------------------------------------------------------------
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  v_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id', to_jsonb(new) ->> 'key', to_jsonb(old) ->> 'key', to_jsonb(new) ->> 'code');
  insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value)
  values (public.my_employee_id(), lower(tg_op), tg_table_name, v_id,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_employees after insert or update or delete on public.employees for each row execute function public.audit_row_change();
create trigger audit_teams after insert or update or delete on public.teams for each row execute function public.audit_row_change();
create trigger audit_task_types after insert or update or delete on public.task_types for each row execute function public.audit_row_change();
create trigger audit_parameters after insert or update or delete on public.evaluation_parameters for each row execute function public.audit_row_change();
create trigger audit_settings after insert or update or delete on public.settings for each row execute function public.audit_row_change();
create trigger audit_periods after update or delete on public.reporting_periods for each row execute function public.audit_row_change();
create trigger audit_grants after insert on public.appeal_resubmission_grants for each row execute function public.audit_row_change();

create or replace function public.audit_score_adjustment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value, reason)
  values (new.approved_by, 'score_adjusted', 'evaluations', new.evaluation_id::text,
          jsonb_build_object('kind', new.kind, 'parameter_id', new.parameter_id, 'value', new.original_value),
          jsonb_build_object('kind', new.kind, 'parameter_id', new.parameter_id, 'value', new.revised_value, 'appeal_id', new.appeal_id),
          new.reason);
  return new;
end $$;
create trigger audit_score_adjustments after insert on public.score_adjustments for each row execute function public.audit_score_adjustment();

create or replace function public.audit_appeal_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value)
    values (public.my_employee_id(), 'appeal_status', 'appeals', new.id::text,
            jsonb_build_object('status', old.status), jsonb_build_object('status', new.status, 'reference', new.reference));
  end if;
  return new;
end $$;
create trigger audit_appeals after update on public.appeals for each row execute function public.audit_appeal_status();

-- ---------------------------------------------------------------------------
-- Link Supabase Auth users to employee records by email (invite-only).
-- ---------------------------------------------------------------------------
create or replace function public.link_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.employees set auth_user_id = new.id
   where email = lower(new.email) and auth_user_id is null;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.link_auth_user();

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on function
  public.my_employee_id(), public.my_role(), public.is_super_admin(), public.is_service_role(),
  public.is_lead_of(uuid), public.can_view_cam(uuid), public.period_is_published(uuid),
  public.can_view_evaluation(uuid), public.can_view_appeal(uuid), public.get_setting(text),
  public.appeal_deadline(uuid),
  public.submit_appeal(uuid, text, jsonb, boolean), public.submit_draft_appeal(uuid),
  public.lead_review_appeal(uuid, public.lead_recommendation, text, text),
  public.respond_to_appeal_request(uuid, text), public.add_appeal_comment(uuid, text, boolean),
  public.qa_request_info(uuid, text, text), public.qa_decide_appeal(uuid, jsonb, text, jsonb),
  public.qa_reopen_appeal(uuid, text), public.close_appeal(uuid, text),
  public.grant_appeal_resubmission(uuid, uuid, boolean, text),
  public.admin_adjust_score(uuid, uuid, numeric, text),
  public.set_period_status(uuid, public.period_status),
  public.publish_due_periods(), public.appeal_sla_sweep(),
  public.mark_notifications_read(uuid[]), public.import_evaluations(jsonb)
to authenticated;
grant execute on function public.publish_due_periods(), public.appeal_sla_sweep(), public.import_evaluations(jsonb),
  public.is_service_role(), public.get_setting(text) to service_role;
