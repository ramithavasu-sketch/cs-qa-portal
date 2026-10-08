-- =============================================================================
-- Feed of portal score changes for writing back to the Google Sheet.
-- One row per score_adjustments row created after p_since, with what the sheet
-- needs to find and update the original audit row (DS Task Link + CAM email +
-- QA Week label) and the column to change (the parameter's sheet column name).
-- Only the service role (the sheets-push Edge Function) may call it.
-- =============================================================================
create or replace function public.score_changes_since(p_since timestamptz)
returns table (
  change_id uuid, changed_at timestamptz, kind text,
  task_link text, task_id text, cam_email text, cam_name text, qa_week text, task_type text,
  parameter_name text, sheet_column text, sheet_column_aliases text[],
  original_value numeric, revised_value numeric, task_score numeric, autofail boolean,
  reason text, approved_by text, appeal_reference text
) language sql stable security definer set search_path = public as $$
  select sa.id, sa.created_at, sa.kind::text,
         e.task_link, e.task_id, cam.email, cam.full_name, rp.label, e.task_type,
         p.name, nullif(trim(p.source_column), ''), p.source_aliases,
         sa.original_value, sa.revised_value, v.score, v.autofail,
         sa.reason, ap.full_name, a.reference
  from public.score_adjustments sa
  join public.evaluations e on e.id = sa.evaluation_id
  join public.employees cam on cam.id = e.cam_id
  join public.reporting_periods rp on rp.id = e.period_id
  join public.v_evaluations_effective v on v.id = e.id
  left join public.evaluation_parameters p on p.id = sa.parameter_id
  left join public.employees ap on ap.id = sa.approved_by
  left join public.appeals a on a.id = sa.appeal_id
  where sa.created_at > coalesce(p_since, '-infinity'::timestamptz) and not e.is_demo
  order by sa.created_at, sa.id
  limit 500
$$;
revoke execute on function public.score_changes_since(timestamptz) from public, anon, authenticated;
grant execute on function public.score_changes_since(timestamptz) to service_role;
