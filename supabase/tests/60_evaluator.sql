-- QA Evaluator role + score change feed (migrations 0012–0014). Runs after 10–50, reusing their fixtures.
set client_min_messages = notice;
reset session authorization;
insert into auth.users (email) values ('eval@test.co');
insert into public.employees (email, full_name, role) values ('eval@test.co', 'Eva Evaluator', 'evaluator');
update public.employees e set auth_user_id = u.id from auth.users u where u.email = e.email and e.email = 'eval@test.co';
insert into public.test_ids select 'eval', id from public.employees where email = 'eval@test.co';
-- a draft week with one audit, to check draft visibility
insert into public.reporting_periods (label, short_label, year, week_number, start_date, end_date) values ('EVAL-DRAFT', 'ED-1', 2026, 52, '2026-12-24', '2026-12-30');
insert into public.evaluations (task_id, task_link, cam_id, task_type, audited_at, period_id, autofail, original_score)
select 'ev-draft', 'https://ds.test/crm#task/ev-draft', public.tid('cam_a1'), 'INTERNAL', now(), id, false, 100 from public.reporting_periods where label = 'EVAL-DRAFT';

-- reads: everything QA sees
select public.test_as('eval@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) from public.evaluations) = (select count(*) from public.v_evaluations_effective), 'evaluator reads evaluations through the effective view');
select public.assert_true(exists (select 1 from public.evaluations where task_id = 'ev-draft'), 'evaluator sees audits in draft weeks');
select public.assert_true(exists (select 1 from public.reporting_periods where label = 'EVAL-DRAFT'), 'evaluator sees draft weeks');
select public.assert_true((select count(*) from public.appeals) >= 3, 'evaluator sees all appeals');
select public.assert_true(exists (select 1 from public.appeal_events where visibility = 'internal'), 'evaluator sees internal comments');
select public.assert_true((select count(*) from public.audit_logs) = 0, 'evaluator cannot read the audit log');
select public.assert_true((select count(*) from public.import_batches) = 0, 'evaluator cannot read import batches');
-- writes they may not do
select public.expect_error($$ select public.import_evaluations('{"rows": []}'::jsonb) $$, '%Only QA Super Admins%', 'evaluator cannot import audits');
select public.expect_error($$ select public.import_team_mapping('[]') $$, '%Only QA Super Admins%', 'evaluator cannot import the team mapping');
select public.expect_error($$ insert into public.employees (email, full_name, role) values ('x@test.co', 'X', 'user') $$, '%row-level security%', 'evaluator cannot add users');
update public.settings set value = '{"green": 1, "amber": 0}' where key = 'thresholds';   -- RLS: 0 rows
update public.teams set name = 'Renamed by evaluator';                                     -- RLS: 0 rows
update public.evaluation_parameters set max_score = 99;                                    -- RLS: 0 rows
reset session authorization;
select public.assert_true((select (value ->> 'green')::numeric <> 1 from public.settings where key = 'thresholds'), 'evaluator cannot change settings');
select public.assert_true(not exists (select 1 from public.teams where name = 'Renamed by evaluator'), 'evaluator cannot change teams');
select public.assert_true(not exists (select 1 from public.evaluation_parameters where max_score = 99), 'evaluator cannot change scoring');

-- weeks: publish, closing date yes; other fields no
select public.test_as('eval@test.co'); set session authorization authenticated;
select public.set_period_status((select id from public.reporting_periods where label = 'EVAL-DRAFT'), 'published');
select public.assert_true((select status = 'published' from public.reporting_periods where label = 'EVAL-DRAFT'), 'evaluator can publish a week');
update public.reporting_periods set appeal_closes_at = now() + interval '3 days' where label = 'EVAL-DRAFT';
select public.assert_true((select appeal_closes_at is not null from public.reporting_periods where label = 'EVAL-DRAFT'), 'evaluator can set the appeal closing date');
select public.expect_error($$ update public.reporting_periods set label = 'EVAL-RENAMED' where label = 'EVAL-DRAFT' $$, '%only change a week%', 'evaluator cannot rename or move a week');
select public.expect_error($$ insert into public.reporting_periods (label, short_label, year, week_number, start_date, end_date) values ('EV-NEW', 'EV', 2027, 1, '2027-01-01', '2027-01-07') $$,
  '%row-level security%', 'evaluator cannot add weeks');
select public.set_period_status((select id from public.reporting_periods where label = 'EVAL-DRAFT'), 'draft');
reset session authorization;

-- appeals: QA notification on forward, decision, correction
select public.test_as((select l.email from public.appeals a join public.employees l on l.id = a.lead_id where a.id = public.tid('appeal_fixed'))); set session authorization authenticated;
select public.lead_review_appeal(public.tid('appeal_fixed'), 'recommend_approval', 'Forwarding for the evaluator to decide.');
reset session authorization;
select public.assert_true(exists (select 1 from public.notifications where recipient_id = public.tid('eval') and type = 'appeal_forwarded' and appeal_id = public.tid('appeal_fixed')),
  'evaluators are notified when an appeal reaches QA');
select public.test_as('eval@test.co'); set session authorization authenticated;
select public.qa_decide_appeal(public.tid('appeal_fixed'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 5, 'reason', 'Notes were complete')) from public.appeal_items where appeal_id = public.tid('appeal_fixed')),
  'Approved by the evaluator after checking the notes.');
select public.assert_true((select status = 'approved' and decided_by = public.tid('eval') from public.appeals where id = public.tid('appeal_fixed')), 'evaluator can decide an appeal');
select public.admin_adjust_score(public.tid('ev_b1'), '00000000-0000-4000-a000-000000000401', 70, 'Calibration correction by the evaluator');
select public.assert_true(exists (select 1 from public.score_adjustments where approved_by = public.tid('eval') and appeal_id is null), 'evaluator can correct a finalized score');
select public.expect_error($$ select public.lead_review_appeal(public.tid('appeal1'), 'recommend_approval', 'not a lead') $$, '%Team Lead%', 'evaluator cannot act as a Team Lead');
reset session authorization;

-- CAM / Lead still cannot do QA things
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true(not exists (select 1 from public.evaluations where task_id = 'ev-draft'), 'CAM still cannot see draft-week audits');
select public.expect_error($$ select public.set_period_status((select id from public.reporting_periods limit 1), 'published') $$, '%Only QA%', 'CAM still cannot publish');
reset session authorization;

-- score change feed for the Google Sheet: service role only
select public.test_as('eval@test.co'); set session authorization authenticated;
select public.expect_error($$ select * from public.score_changes_since(null) $$, '%permission denied%', 'signed-in users cannot read the sheet feed');
reset session authorization;
set session authorization service_role;
select public.assert_true((select count(*) > 0 from public.score_changes_since(null)), 'feed lists score changes');
select public.assert_true((select bool_and(task_link is not null and cam_email is not null and qa_week is not null) from public.score_changes_since(null)), 'feed has the keys to find the sheet row');
select public.assert_true((select count(*) = 0 from public.score_changes_since(now())), 'feed returns nothing newer than now');
select public.assert_true(exists (select 1 from public.score_changes_since(null) where kind = 'parameter' and sheet_column is not null and reason = 'Calibration correction by the evaluator' and approved_by = 'Eva Evaluator'),
  'feed has the sheet column, reason and approver');
reset session authorization;
\echo '--- evaluator assertions passed ---'
