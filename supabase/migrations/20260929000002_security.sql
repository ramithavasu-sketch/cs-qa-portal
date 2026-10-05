-- =============================================================================
-- Identity helpers, effective-score views and Row Level Security
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Identity helpers (SECURITY DEFINER so policies don't recurse into employees)
-- ---------------------------------------------------------------------------
create or replace function public.my_employee_id()
returns uuid language sql stable security definer set search_path = public as $$
  select e.id from public.employees e
  where e.auth_user_id = auth.uid() and e.status = 'active'
$$;

create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select e.role from public.employees e
  where e.auth_user_id = auth.uid() and e.status = 'active'
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'super_admin', false)
$$;

create or replace function public.is_service_role()
returns boolean language sql stable as $$
  select coalesce(auth.role() = 'service_role', false)
$$;

-- True when the caller is an active Admin (Team Lead) who leads the CAM's team.
create or replace function public.is_lead_of(p_cam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.employees c
    join public.teams t on t.id = c.team_id
    where c.id = p_cam
      and t.lead_id = public.my_employee_id()
      and public.my_role() = 'admin'
  )
$$;

create or replace function public.can_view_cam(p_cam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or p_cam = public.my_employee_id()
      or public.is_lead_of(p_cam)
$$;

create or replace function public.period_is_published(p_period uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.reporting_periods where id = p_period and status = 'published')
$$;

create or replace function public.can_view_evaluation(p_eval uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.evaluations e
    where e.id = p_eval
      and (public.is_super_admin()
           or (public.can_view_cam(e.cam_id) and public.period_is_published(e.period_id)))
  )
$$;

create or replace function public.can_view_appeal(p_appeal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.appeals a
    where a.id = p_appeal
      and (public.is_super_admin()
           or a.cam_id = public.my_employee_id()
           or (public.my_role() = 'admin' and (a.lead_id = public.my_employee_id() or public.is_lead_of(a.cam_id))))
  )
$$;

create or replace function public.get_setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from public.settings where key = p_key
$$;

-- ---------------------------------------------------------------------------
-- Effective (appeal-adjusted) views. security_invoker => base-table RLS applies.
-- ---------------------------------------------------------------------------
create or replace view public.v_evaluation_scores_effective
with (security_invoker = true) as
select
  s.id,
  s.evaluation_id,
  s.parameter_id,
  p.name        as parameter_name,
  p.section,
  p.sort_order,
  s.max_score,
  s.earned      as original_earned,
  case when a.id is null then s.earned else a.revised_value end as earned,
  (a.id is not null) as adjusted,
  s.remarks
from public.evaluation_scores s
join public.evaluation_parameters p on p.id = s.parameter_id
left join lateral (
  select sa.id, sa.revised_value
  from public.score_adjustments sa
  where sa.evaluation_id = s.evaluation_id and sa.kind = 'parameter' and sa.parameter_id = s.parameter_id
  order by sa.created_at desc, sa.id desc
  limit 1
) a on true;

create or replace view public.v_evaluations_effective
with (security_invoker = true) as
select
  e.id, e.task_id, e.task_link, e.cam_id, e.evaluator_id, e.evaluator_email, e.evaluator_name,
  e.task_type, tt.name as task_type_name, e.request_from, e.task_loaded_date, e.audited_at,
  e.period_id, rp.label as period_label, rp.short_label as period_short_label,
  rp.start_date as period_start, rp.end_date as period_end, rp.status as period_status, rp.published_at,
  e.task_seq, e.connection_id, e.screenshot_url, e.fcr, e.feedback, e.is_demo,
  cam.full_name as cam_name, cam.email as cam_email, cam.team_id, t.name as team_name,
  t.lead_id, ld.full_name as lead_name,
  e.autofail as original_autofail,
  e.original_score,
  coalesce(afa.revised_value = 1, e.autofail) as autofail,
  case
    when afa.id is null and coalesce(sums.adjusted_count, 0) = 0 then e.original_score
    when coalesce(afa.revised_value = 1, e.autofail) then 0
    when sums.max_sum > 0 then round(100 * sums.earned_sum / sums.max_sum, 2)
    else e.original_score
  end as score,
  (afa.id is not null or coalesce(sums.adjusted_count, 0) > 0) as adjusted
from public.evaluations e
join public.task_types tt on tt.code = e.task_type
join public.reporting_periods rp on rp.id = e.period_id
join public.employees cam on cam.id = e.cam_id
left join public.teams t on t.id = cam.team_id
left join public.employees ld on ld.id = t.lead_id
left join lateral (
  select sa.id, sa.revised_value
  from public.score_adjustments sa
  where sa.evaluation_id = e.id and sa.kind = 'autofail'
  order by sa.created_at desc, sa.id desc
  limit 1
) afa on true
left join lateral (
  select sum(v.earned) filter (where v.earned is not null)    as earned_sum,
         sum(v.max_score) filter (where v.earned is not null) as max_sum,
         count(*) filter (where v.adjusted)                   as adjusted_count
  from public.v_evaluation_scores_effective v
  where v.evaluation_id = e.id
) sums on true;

-- Appeals with SLA information (days pending / overdue).
create or replace view public.v_appeals
with (security_invoker = true) as
select
  a.*,
  e.task_id, e.task_link, e.task_type, e.period_id, rp.label as period_label, rp.short_label as period_short_label,
  e.audited_at, e.evaluator_name, e.original_score,
  cam.full_name as cam_name, cam.email as cam_email,
  ld.full_name as lead_name,
  greatest(0, extract(epoch from (now() - a.status_changed_at)) / 86400)::numeric(8,1) as days_in_status,
  case
    when a.status = 'pending_lead_review'
      then now() > a.status_changed_at + make_interval(days => coalesce((public.get_setting('sla') ->> 'lead_review_days')::int, 2))
    when a.status = 'pending_qa_review'
      then now() > a.status_changed_at + make_interval(days => coalesce((public.get_setting('sla') ->> 'qa_review_days')::int, 3))
    when a.status in ('returned_to_cam', 'pending_additional_info')
      then a.info_due_at is not null and now() > a.info_due_at
    else false
  end as overdue
from public.appeals a
join public.evaluations e on e.id = a.evaluation_id
join public.reporting_periods rp on rp.id = e.period_id
join public.employees cam on cam.id = a.cam_id
left join public.employees ld on ld.id = a.lead_id;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.employees                  enable row level security;
alter table public.teams                      enable row level security;
alter table public.task_types                 enable row level security;
alter table public.evaluation_parameters      enable row level security;
alter table public.settings                   enable row level security;
alter table public.reporting_periods          enable row level security;
alter table public.import_batches             enable row level security;
alter table public.import_rejections          enable row level security;
alter table public.evaluations                enable row level security;
alter table public.evaluation_scores          enable row level security;
alter table public.appeals                    enable row level security;
alter table public.appeal_items               enable row level security;
alter table public.appeal_events              enable row level security;
alter table public.appeal_evidence            enable row level security;
alter table public.appeal_resubmission_grants enable row level security;
alter table public.score_adjustments          enable row level security;
alter table public.notifications              enable row level security;
alter table public.email_outbox               enable row level security;
alter table public.audit_logs                 enable row level security;

-- employees: self, own team (Lead), all staff names (Leads/QA), everything for Super Admin.
create policy employees_select on public.employees for select to authenticated using (
  public.is_super_admin()
  or id = public.my_employee_id()
  or public.is_lead_of(id)
  or role in ('admin', 'super_admin')
);
create policy employees_write on public.employees for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

create policy teams_select on public.teams for select to authenticated using (public.my_employee_id() is not null);
create policy teams_write on public.teams for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

create policy task_types_select on public.task_types for select to authenticated using (public.my_employee_id() is not null);
create policy task_types_write on public.task_types for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

create policy parameters_select on public.evaluation_parameters for select to authenticated using (public.my_employee_id() is not null);
create policy parameters_write on public.evaluation_parameters for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

create policy settings_select on public.settings for select to authenticated using (public.my_employee_id() is not null);
create policy settings_write on public.settings for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- Non-QA users only see published weeks.
create policy periods_select on public.reporting_periods for select to authenticated using (
  public.is_super_admin() or (status = 'published' and public.my_employee_id() is not null)
);
create policy periods_write on public.reporting_periods for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

create policy import_batches_select on public.import_batches for select to authenticated using (public.is_super_admin());
create policy import_rejections_select on public.import_rejections for select to authenticated using (public.is_super_admin());

-- Evaluations: read-only for everyone; writes only through SECURITY DEFINER RPCs.
create policy evaluations_select on public.evaluations for select to authenticated using (
  public.is_super_admin()
  or (public.can_view_cam(cam_id) and public.period_is_published(period_id))
);
create policy evaluation_scores_select on public.evaluation_scores for select to authenticated using (
  public.can_view_evaluation(evaluation_id)
);
create policy score_adjustments_select on public.score_adjustments for select to authenticated using (
  public.can_view_evaluation(evaluation_id)
);

create policy appeals_select on public.appeals for select to authenticated using (public.can_view_appeal(id));
create policy appeal_items_select on public.appeal_items for select to authenticated using (public.can_view_appeal(appeal_id));
-- CAMs never see Lead/QA internal comments.
create policy appeal_events_select on public.appeal_events for select to authenticated using (
  public.can_view_appeal(appeal_id)
  and (visibility = 'shared' or public.my_role() in ('admin', 'super_admin'))
);
create policy appeal_evidence_select on public.appeal_evidence for select to authenticated using (public.can_view_appeal(appeal_id));
create policy grants_select on public.appeal_resubmission_grants for select to authenticated using (
  public.is_super_admin() or public.can_view_evaluation(evaluation_id)
);

create policy notifications_select on public.notifications for select to authenticated using (recipient_id = public.my_employee_id());

create policy audit_logs_select on public.audit_logs for select to authenticated using (public.is_super_admin());
-- email_outbox: no policies => only service_role (Edge Function) can access.

-- ---------------------------------------------------------------------------
-- Privileges: nothing for anon; read for authenticated (RLS filters rows).
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.employees, public.teams, public.task_types,
  public.evaluation_parameters, public.settings, public.reporting_periods to authenticated;
revoke all on public.email_outbox from authenticated;
