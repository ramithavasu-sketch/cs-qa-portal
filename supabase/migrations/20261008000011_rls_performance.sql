-- =============================================================================
-- Row Level Security performance. The rules are unchanged; they are now worked
-- out ONCE per query instead of once per row:
--   * evaluations: the caller's visible CAMs and the published weeks are computed
--     by two SECURITY DEFINER set functions, wrapped in (select …) so Postgres
--     runs them once (an "initPlan") and hashes the result.
--   * evaluation_scores / score_adjustments: visible when their evaluation is
--     visible (a semi-join on the already-filtered evaluations), instead of a
--     per-row can_view_evaluation() call.
-- With ~12k evaluations and ~85k score rows the previous policies exceeded the
-- 8-second statement timeout. Safe to run more than once.
-- =============================================================================

-- CAMs whose data the caller may see: everyone for QA, own team for a Lead, self for a CAM.
create or replace function public.my_visible_cam_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select e.id from public.employees e where public.is_super_admin()
  union
  select public.my_employee_id() where public.my_employee_id() is not null
  union
  select c.id from public.employees c join public.teams t on t.id = c.team_id
   where public.my_role() = 'admin' and t.lead_id = public.my_employee_id()
$$;

-- Weeks the caller may see: all for QA, published weeks for everyone else with an account.
create or replace function public.my_visible_period_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from public.reporting_periods p
   where public.is_super_admin() or (p.status = 'published' and public.my_employee_id() is not null)
$$;

revoke execute on function public.my_visible_cam_ids(), public.my_visible_period_ids() from public, anon;
grant execute on function public.my_visible_cam_ids(), public.my_visible_period_ids() to authenticated;

drop policy if exists evaluations_select on public.evaluations;
create policy evaluations_select on public.evaluations for select to authenticated using (
  (select public.is_super_admin())
  or (cam_id in (select public.my_visible_cam_ids()) and period_id in (select public.my_visible_period_ids()))
);

drop policy if exists evaluation_scores_select on public.evaluation_scores;
create policy evaluation_scores_select on public.evaluation_scores for select to authenticated using (
  (select public.is_super_admin())
  or evaluation_id in (select e.id from public.evaluations e)   -- evaluations' own policy applies
);

drop policy if exists score_adjustments_select on public.score_adjustments;
create policy score_adjustments_select on public.score_adjustments for select to authenticated using (
  (select public.is_super_admin())
  or evaluation_id in (select e.id from public.evaluations e)
);

-- Lookups the views and policies use.
create index if not exists score_adjustments_eval_kind_param_idx on public.score_adjustments (evaluation_id, kind, parameter_id, created_at desc);
create index if not exists employees_auth_user_idx on public.employees (auth_user_id);
create index if not exists teams_lead_idx on public.teams (lead_id);
create index if not exists evaluations_period_audited_idx on public.evaluations (period_id, audited_at desc);

-- ---------------------------------------------------------------------------
-- Effective-score view: only recalculate a task score when the task actually has
-- a score adjustment (almost none do). Same columns and results as before.
-- ---------------------------------------------------------------------------
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
  case when adj.has_adj then coalesce((select sa.revised_value = 1 from public.score_adjustments sa where sa.evaluation_id = e.id and sa.kind = 'autofail' order by sa.created_at desc, sa.id desc limit 1), e.autofail) else e.autofail end as autofail,
  case
    when not adj.has_adj then e.original_score
    when coalesce((select sa.revised_value = 1 from public.score_adjustments sa where sa.evaluation_id = e.id and sa.kind = 'autofail' order by sa.created_at desc, sa.id desc limit 1), e.autofail) then 0
    else coalesce((
      select round(100 * sum(v.earned) filter (where v.earned is not null) / nullif(sum(v.max_score) filter (where v.earned is not null), 0), 2)
      from public.v_evaluation_scores_effective v where v.evaluation_id = e.id), e.original_score)
  end as score,
  adj.has_adj as adjusted
from public.evaluations e
join public.task_types tt on tt.code = e.task_type
join public.reporting_periods rp on rp.id = e.period_id
join public.employees cam on cam.id = e.cam_id
left join public.teams t on t.id = cam.team_id
left join public.employees ld on ld.id = t.lead_id
cross join lateral (select exists (select 1 from public.score_adjustments sa where sa.evaluation_id = e.id) as has_adj) adj;
