-- Removes all demo data from a development project (run in the SQL editor as postgres).
begin;
set local app.allow_evaluation_purge = 'on';
delete from public.score_adjustments where evaluation_id in (select id from public.evaluations where is_demo);
delete from public.appeal_resubmission_grants where evaluation_id in (select id from public.evaluations where is_demo);
delete from public.appeals where is_demo;               -- cascades to items, events, evidence rows
delete from public.evaluations where is_demo;           -- cascades to evaluation_scores
delete from public.reporting_periods p where p.is_demo and not exists (select 1 from public.evaluations e where e.period_id = p.id);
update public.audit_logs set actor_id = null where actor_id in (select id from public.employees where is_demo);
update public.import_batches set uploaded_by = null where uploaded_by in (select id from public.employees where is_demo);
update public.settings set updated_by = null where updated_by in (select id from public.employees where is_demo);
update public.reporting_periods set published_by = null where published_by in (select id from public.employees where is_demo);
update public.employees set team_id = null where is_demo;
delete from public.teams where is_demo;
delete from auth.users where email like '%@demo.csqa.test';
delete from public.employees where is_demo;             -- cascades to notifications
commit;
