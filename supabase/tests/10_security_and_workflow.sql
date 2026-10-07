-- =============================================================================
-- Security + workflow test suite (run by scripts/test-db.sh as postgres).
-- Each identity switch uses Supabase's JWT claim settings + SET ROLE authenticated,
-- exactly as PostgREST does, so RLS and function checks are exercised for real.
-- =============================================================================
\set QUIET on
set client_min_messages = warning;

-- ---------- test helpers ------------------------------------------------------
create table public.test_ids (k text primary key, v uuid);
grant select, insert on public.test_ids to authenticated;
create function public.tid(p text) returns uuid language sql stable as $$ select v from public.test_ids where k = p $$;
grant execute on function public.tid(text) to authenticated;

create function public.test_as(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce((select id::text from auth.users where email = p_email), ''), false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
end $$;

create function public.assert_true(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'TEST FAIL: %', p_msg; end if;
  raise notice 'ok  %', p_msg;
end $$;
grant execute on function public.assert_true(boolean, text) to authenticated;

create function public.expect_error(p_sql text, p_pattern text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ilike p_pattern then
      raise notice 'ok  % (rejected: %)', p_msg, sqlerrm;
      return;
    end if;
    raise exception 'TEST FAIL: % — unexpected error: %', p_msg, sqlerrm;
  end;
  raise exception 'TEST FAIL: % — statement succeeded but should have been rejected', p_msg;
end $$;
grant execute on function public.expect_error(text, text, text) to authenticated;

set client_min_messages = notice;

-- ---------- fixtures (as postgres, bypassing RLS) -----------------------------
insert into auth.users (email) values
  ('qa@test.co'), ('lead.a@test.co'), ('lead.b@test.co'), ('cam.a1@test.co'), ('cam.a2@test.co'), ('cam.b1@test.co'), ('stranger@test.co');

insert into public.employees (email, full_name, role) values
  ('qa@test.co', 'QA One', 'super_admin'),
  ('lead.a@test.co', 'Lead Alpha', 'admin'),
  ('lead.b@test.co', 'Lead Beta', 'admin'),
  ('cam.a1@test.co', 'Cam A1', 'user'),
  ('cam.a2@test.co', 'Cam A2', 'user'),
  ('cam.b1@test.co', 'Cam B1', 'user');
-- link auth users (trigger only fires for new auth users; employees were created after)
update public.employees e set auth_user_id = u.id from auth.users u where u.email = e.email;

insert into public.teams (name, lead_id) select 'Team Alpha', id from public.employees where email = 'lead.a@test.co';
insert into public.teams (name, lead_id) select 'Team Beta', id from public.employees where email = 'lead.b@test.co';
update public.employees set team_id = (select id from public.teams where name = 'Team Alpha') where email in ('cam.a1@test.co', 'cam.a2@test.co');
update public.employees set team_id = (select id from public.teams where name = 'Team Beta') where email = 'cam.b1@test.co';

insert into public.test_ids select 'qa', id from public.employees where email = 'qa@test.co';
insert into public.test_ids select 'lead_a', id from public.employees where email = 'lead.a@test.co';
insert into public.test_ids select 'lead_b', id from public.employees where email = 'lead.b@test.co';
insert into public.test_ids select 'cam_a1', id from public.employees where email = 'cam.a1@test.co';
insert into public.test_ids select 'cam_a2', id from public.employees where email = 'cam.a2@test.co';
insert into public.test_ids select 'cam_b1', id from public.employees where email = 'cam.b1@test.co';

-- =============================================================================
-- 1. Import (as QA) — validation, duplicates, period creation
-- =============================================================================
select public.test_as('qa@test.co');
set session authorization authenticated;

create temp table import_result as
select public.import_evaluations(jsonb_build_object(
  'source', 'csv', 'file_name', 'test.csv', 'publish_new_periods', false,
  'rows', jsonb_build_array(
    -- r1: ER, cam A1, 85 (checklist 0, email structure 15 -> wait: 30+15+15+10+15+0 = 85)
    jsonb_build_object('row_number', 2, 'task_link', 'https://ds.test/crm#task/t-1', 'task_id', 't-1', 'cam_email', 'cam.a1@test.co',
      'evaluator_email', 'qa@test.co', 'evaluator_name', 'QA One', 'task_type', 'ER', 'request_from', 'Client',
      'task_loaded_date', '2026-09-25', 'audited_at', '2026-09-28T10:00:00Z', 'autofail', false, 'fcr', 'Yes', 'score', 85, 'feedback', 'Missed checklist',
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000101', 'earned', 30),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000102', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000103', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000104', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000105', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000106', 'earned', 0))),
    -- r2: exact duplicate of r1 (same link/cam/week)
    jsonb_build_object('row_number', 3, 'task_link', 'https://ds.test/crm#task/t-1', 'task_id', 't-1', 'cam_email', 'cam.a1@test.co',
      'task_type', 'ER', 'audited_at', '2026-09-28T10:00:00Z', 'autofail', false, 'score', 85,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000101', 'earned', 30),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000102', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000103', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000104', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000105', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000106', 'earned', 0))),
    -- r3: score does not match parameter sum -> rejected
    jsonb_build_object('row_number', 4, 'task_link', 'https://ds.test/crm#task/t-bad', 'cam_email', 'cam.a1@test.co',
      'task_type', 'INTERNAL', 'audited_at', '2026-09-28T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 0),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10))),
    -- r4: missing CAM email -> rejected
    jsonb_build_object('row_number', 5, 'task_link', 'https://ds.test/crm#task/t-x', 'cam_email', '', 'task_type', 'ER', 'score', 100,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)'), 'scores', '[]'::jsonb),
    -- r5: Internal autofail for cam A2 (score 0)
    jsonb_build_object('row_number', 6, 'task_link', 'https://ds.test/crm#task/t-2', 'task_id', 't-2', 'cam_email', 'cam.a2@test.co',
      'task_type', 'INTERNAL', 'audited_at', '2026-09-28T11:00:00Z', 'autofail', true, 'score', 0,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 0),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 0),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 0))),
    -- r6: cam B1 (other team), 100
    jsonb_build_object('row_number', 7, 'task_link', 'https://ds.test/crm#task/t-3', 'task_id', 't-3', 'cam_email', 'cam.b1@test.co',
      'task_type', 'INTERNAL', 'audited_at', '2026-09-28T12:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10))),
    -- r7: new CAM not yet in the directory -> auto-created, mapped to Team Beta via Lead Name
    jsonb_build_object('row_number', 8, 'task_link', 'https://ds.test/crm#task/t-4', 'task_id', 't-4', 'cam_email', 'New.Cam@test.co', 'cam_name', 'New Cam',
      'lead_name', 'lead beta', 'task_type', 'INTERNAL', 'audited_at', '2026-09-28T12:00:00Z', 'autofail', false, 'score', 90,
      'period', jsonb_build_object('label', 'WK-39 : 2026 (09/24- 09/30)', 'short_label', 'WK-39', 'year', 2026, 'week', 39, 'start', '2026-09-24', 'end', '2026-09-30'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 0),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10)))
  ))) as r;

select public.assert_true((select (r ->> 'inserted')::int = 4 from import_result), 'import inserted 4 valid rows');
select public.assert_true((select (r ->> 'duplicates')::int = 1 from import_result), 'import skipped 1 duplicate');
select public.assert_true((select (r ->> 'rejected')::int = 2 from import_result), 'import rejected 2 invalid rows');
select public.assert_true((select count(*) = 2 from public.import_rejections), 'rejection reasons recorded');
select public.assert_true(exists (select 1 from public.import_rejections where reason like 'Score 100 does not match%'), 'score/rubric mismatch reported');
select public.assert_true((select e.team_id = t.id from public.employees e, public.teams t where e.email = 'new.cam@test.co' and t.name = 'Team Beta'),
  'unknown CAM auto-created and mapped to team via Lead Name');
select public.assert_true((select status = 'draft' from public.reporting_periods where short_label = 'WK-39'), 'new period created as draft');

reset session authorization;
insert into public.test_ids select 'period', id from public.reporting_periods where short_label = 'WK-39';
insert into public.test_ids select 'ev_a1', id from public.evaluations where task_id = 't-1';
insert into public.test_ids select 'ev_a2', id from public.evaluations where task_id = 't-2';
insert into public.test_ids select 'ev_b1', id from public.evaluations where task_id = 't-3';

-- =============================================================================
-- 2. Unpublished weeks are hidden from CAMs and Leads
-- =============================================================================
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.evaluations), 'CAM cannot see evaluations in a draft week');
select public.assert_true((select count(*) = 0 from public.reporting_periods), 'CAM cannot see draft periods');
select public.expect_error($$ select public.set_period_status(public.tid('period'), 'published') $$, '%Only QA%', 'CAM cannot publish a week');

reset session authorization; select public.test_as('qa@test.co'); set session authorization authenticated;
select public.set_period_status(public.tid('period'), 'published');
select public.assert_true((select status = 'published' and published_at is not null from public.reporting_periods where id = public.tid('period')), 'QA published the week');

reset session authorization;
select public.assert_true((select count(*) = 1 from public.notifications n join public.employees e on e.id = n.recipient_id
  where e.email = 'cam.a1@test.co' and n.type = 'report_published'), 'CAM notified when weekly report published');

-- =============================================================================
-- 3. Row-level isolation
-- =============================================================================
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 1 from public.evaluations), 'CAM A1 sees only own evaluation');
select public.assert_true((select bool_and(cam_id = public.tid('cam_a1')) from public.v_evaluations_effective), 'effective view filtered to own rows');
select public.assert_true((select count(*) = 0 from public.evaluations where id = public.tid('ev_b1')), 'CAM A1 cannot read CAM B1 evaluation by id');
select public.assert_true((select count(*) = 0 from public.evaluation_scores where evaluation_id = public.tid('ev_a2')), 'CAM A1 cannot read teammate scores');
select public.assert_true((select count(*) = 0 from public.employees where role = 'user' and id <> public.tid('cam_a1')), 'CAM cannot list other CAMs');
select public.assert_true((select count(*) = 0 from public.audit_logs), 'CAM cannot read audit logs');
select public.expect_error($$ update public.evaluations set original_score = 100 where id = public.tid('ev_a1') $$, '%permission denied%', 'CAM cannot update evaluation');
select public.expect_error($$ insert into public.score_adjustments (evaluation_id, kind, parameter_id, original_value, revised_value, reason, approved_by)
  values (public.tid('ev_a1'), 'parameter', '00000000-0000-4000-a000-000000000106', 0, 10, 'self-approve', public.tid('cam_a1')) $$,
  '%permission denied%', 'CAM cannot insert score adjustments');
update public.employees set role = 'super_admin' where id = public.tid('cam_a1'); -- RLS: silently matches 0 rows
reset session authorization;
select public.assert_true((select role = 'user' from public.employees where email = 'cam.a1@test.co'), 'CAM role unchanged after escalation attempt');

select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 2 from public.evaluations), 'Lead A sees both Team Alpha evaluations');
select public.assert_true((select count(*) = 0 from public.evaluations where id = public.tid('ev_b1')), 'Lead A cannot read Team Beta evaluation');
select public.assert_true((select count(*) = 2 from public.employees where role = 'user'), 'Lead A sees only own CAMs in directory');
select public.expect_error($$ select public.admin_adjust_score(public.tid('ev_a1'), '00000000-0000-4000-a000-000000000106', 10, 'lead trying to change score') $$,
  '%Only QA Super Admins%', 'Lead cannot change finalized scores');
update public.evaluation_parameters set max_score = 50; -- RLS: 0 rows
reset session authorization;
select public.assert_true((select max_score = 30 from public.evaluation_parameters where id = '00000000-0000-4000-a000-000000000101'), 'rubric unchanged after Lead attempt');

select public.test_as('stranger@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.evaluations), 'login without employee record sees nothing');
select public.assert_true((select count(*) = 0 from public.teams), 'login without employee record sees no teams');
reset session authorization;

set session authorization anon;
select public.expect_error($$ select count(*) from public.evaluations $$, '%permission denied%', 'anonymous access denied');
reset session authorization;

-- =============================================================================
-- 4. Appeal workflow: CAM -> Lead -> QA
-- =============================================================================
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.submit_appeal(public.tid('ev_b1'), 'This is not my task but I want to appeal it anyway', '[{"parameter_id":"00000000-0000-4000-a000-000000000402"}]') $$,
  '%own evaluations%', 'CAM cannot appeal another CAM''s evaluation');
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'too short', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]') $$,
  '%detailed reason%', 'appeal reason is mandatory and detailed');
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'The checklist was completed in the task notes at 10:42', '[{"is_autofail":true}]') $$,
  '%not marked as an autofail%', 'cannot appeal autofail on a non-autofail task');
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'The checklist was completed in the task notes at 10:42', '[{"parameter_id":"00000000-0000-4000-a000-000000000401"}]') $$,
  '%not part of this evaluation%', 'parameter must belong to the task type');


-- CAM submits a two-parameter appeal (still as CAM A1, role authenticated)
insert into public.test_ids select 'appeal1', public.submit_appeal(public.tid('ev_a1'),
  'The checklist was completed in the task notes at 10:42 and the email subject line was descriptive.',
  '[{"parameter_id":"00000000-0000-4000-a000-000000000106","requested_score":10},{"parameter_id":"00000000-0000-4000-a000-000000000105","requested_score":20}]');
select public.assert_true((select status = 'pending_lead_review' and lead_id = public.tid('lead_a') from public.appeals where id = public.tid('appeal1')),
  'appeal routed to CAM''s Team Lead as Pending Lead Review');
select public.assert_true((select reference like 'APL-2026-%' from public.appeals where id = public.tid('appeal1')), 'appeal reference number generated');
select public.assert_true((select count(*) = 2 from public.appeal_items where appeal_id = public.tid('appeal1')), 'two disputed parameters tracked separately');
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'Second appeal on the same checklist parameter again', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]') $$,
  '%already exists%', 'duplicate active appeal on same task+parameter blocked');
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal1'), '[]', 'CAM trying to decide their own appeal') $$,
  '%Only QA%', 'CAM cannot decide appeals');
select public.expect_error($$ select public.lead_review_appeal(public.tid('appeal1'), 'recommend_approval', 'self forward') $$,
  '%Team Lead%', 'CAM cannot forward own appeal to QA (no Lead bypass)');
select public.expect_error($$ update public.appeals set status = 'pending_qa_review' where id = public.tid('appeal1') $$,
  '%permission denied%', 'CAM cannot change appeal status directly');
reset session authorization;

-- QA cannot decide before Lead review
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal1'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 10)) from public.appeal_items where appeal_id = public.tid('appeal1')),
  'Deciding without lead review') $$, '%forwarded by the Team Lead%', 'QA cannot decide before Lead review');
reset session authorization;

-- Lead B (other team) cannot see or review it
select public.test_as('lead.b@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.appeals where id = public.tid('appeal1')), 'other team''s Lead cannot see the appeal');
select public.expect_error($$ select public.lead_review_appeal(public.tid('appeal1'), 'recommend_approval', 'Looks fine to me') $$,
  '%Team Lead%', 'other team''s Lead cannot review');
reset session authorization;

-- Lead A returns it for clarification, adds an internal note
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.lead_review_appeal(public.tid('appeal1'), 'request_more_info', 'Please attach a screenshot of the task notes.', 'Internal: CAM has had similar misses before.');
select public.assert_true((select status = 'returned_to_cam' and info_due_at is not null from public.appeals where id = public.tid('appeal1')), 'Lead returned appeal to CAM');
reset session authorization;

select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.appeal_events where appeal_id = public.tid('appeal1') and visibility = 'internal'),
  'CAM cannot see Lead internal comments');
select public.assert_true((select count(*) >= 2 from public.appeal_events where appeal_id = public.tid('appeal1')), 'CAM sees shared timeline');
select public.respond_to_appeal_request(public.tid('appeal1'), 'Screenshot attached: notes were saved at 10:42.');
select public.assert_true((select status = 'pending_lead_review' from public.appeals where id = public.tid('appeal1')), 'CAM response returns appeal to Lead');
reset session authorization;

select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 1 from public.appeal_events where appeal_id = public.tid('appeal1') and visibility = 'internal'), 'Lead sees internal note');
select public.lead_review_appeal(public.tid('appeal1'), 'recommend_approval', 'Checklist was completed; subject line is fine.');
select public.assert_true((select status = 'pending_qa_review' and lead_recommendation = 'recommend_approval' from public.appeals where id = public.tid('appeal1')),
  'Lead forwarded appeal to QA with recommendation');
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal1'), '[]', 'Lead trying to finalize the decision') $$,
  '%Only QA%', 'Lead cannot finalize QA decision');
reset session authorization;
select public.assert_true((select count(*) >= 1 from public.notifications n where n.recipient_id = public.tid('qa') and n.type = 'appeal_forwarded'), 'QA notified on forward');

-- QA partially approves: checklist approved (0 -> 10), email structure rejected
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal1'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 99)) from public.appeal_items where appeal_id = public.tid('appeal1')),
  'Out of range revision attempt') $$, '%between 0 and%', 'revised score must be within parameter max');
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal1'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 10)) from public.appeal_items where appeal_id = public.tid('appeal1')),
  'short') $$, '%Resolution remarks%', 'resolution remarks are required');
select public.qa_decide_appeal(public.tid('appeal1'),
  (select jsonb_agg(case when parameter_id = '00000000-0000-4000-a000-000000000106'
                        then jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 10, 'reason', 'Checklist evidence verified')
                        else jsonb_build_object('item_id', id, 'decision', 'rejected', 'reason', 'Subject line was generic') end)
     from public.appeal_items where appeal_id = public.tid('appeal1')),
  'Checklist deduction reverted; email structure deduction upheld.');
select public.assert_true((select status = 'partially_approved' and decided_by = public.tid('qa') from public.appeals where id = public.tid('appeal1')), 'appeal partially approved');
select public.assert_true((select score = 95 and original_score = 85 and adjusted from public.v_evaluations_effective where id = public.tid('ev_a1')),
  'task score recalculated 85 -> 95, original kept');
select public.assert_true((select original_earned = 0 and earned = 10 from public.v_evaluation_scores_effective
  where evaluation_id = public.tid('ev_a1') and parameter_id = '00000000-0000-4000-a000-000000000106'), 'parameter shows original and revised score');
select public.assert_true((select earned = 15 from public.v_evaluation_scores_effective
  where evaluation_id = public.tid('ev_a1') and parameter_id = '00000000-0000-4000-a000-000000000105'), 'rejected parameter unchanged');
select public.assert_true(exists (select 1 from public.audit_logs where action = 'score_adjusted' and record_id = public.tid('ev_a1')::text), 'score change written to audit log');
reset session authorization;

-- the change is visible to CAM and Lead views too
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select score = 95 from public.v_evaluations_effective where id = public.tid('ev_a1')), 'CAM sees recalculated score');
select public.assert_true((select count(*) >= 1 from public.notifications where type = 'appeal_decided'), 'CAM notified of decision');
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'Appealing the checklist a second time after decision', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]') $$,
  '%already exists%', 'decided parameter cannot be re-appealed without QA permission');
reset session authorization;
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.assert_true((select score = 95 from public.v_evaluations_effective where id = public.tid('ev_a1')), 'Lead sees recalculated score');
reset session authorization;

-- QA grants resubmission -> CAM can appeal again once
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.grant_appeal_resubmission(public.tid('ev_a1'), '00000000-0000-4000-a000-000000000105', false, 'New evidence emerged in calibration');
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
insert into public.test_ids select 'appeal_resub', public.submit_appeal(public.tid('ev_a1'),
  'New evidence: the subject line followed the approved template for this client.', '[{"parameter_id":"00000000-0000-4000-a000-000000000105"}]');
select public.assert_true(public.tid('appeal_resub') is not null, 'resubmission allowed after QA grant');
select public.close_appeal(public.tid('appeal_resub'), 'Withdrawn by CAM');
select public.assert_true((select status = 'closed' from public.appeals where id = public.tid('appeal_resub')), 'CAM can withdraw before QA stage');
reset session authorization;

-- Autofail appeal: overturn autofail + mark down other parameters (extra adjustments)
select public.test_as('cam.a2@test.co'); set session authorization authenticated;
insert into public.test_ids select 'appeal_af', public.submit_appeal(public.tid('ev_a2'),
  'The call flow change was saved correctly; the autofail trigger does not apply here.', '[{"is_autofail":true}]');
reset session authorization;
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.lead_review_appeal(public.tid('appeal_af'), 'recommend_approval', 'Change was saved - verified in SB.');
reset session authorization;
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.qa_request_info(public.tid('appeal_af'), 'lead', 'Please confirm the timestamp of the SB verification.');
select public.assert_true((select status = 'pending_additional_info' from public.appeals where id = public.tid('appeal_af')), 'QA requested additional info');
reset session authorization;
select public.test_as('cam.a2@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.respond_to_appeal_request(public.tid('appeal_af'), 'Answering for the lead') $$, '%not the person%', 'CAM cannot answer a request aimed at the Lead');
reset session authorization;
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.respond_to_appeal_request(public.tid('appeal_af'), 'SB verified at 14:05, see screenshot.');
reset session authorization;
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.qa_decide_appeal(public.tid('appeal_af'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'reason', 'Autofail criteria not met')) from public.appeal_items where appeal_id = public.tid('appeal_af')),
  'Reverted from autofail; marked down for resolution and documentation instead.',
  jsonb_build_array(
    jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'revised_score', 60, 'reason', 'Partial resolution'),
    jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'revised_score', 10, 'reason', 'Within ATT'),
    jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'revised_score', 5, 'reason', 'Notes incomplete')));
select public.assert_true((select status = 'approved' from public.appeals where id = public.tid('appeal_af')), 'autofail appeal approved');
select public.assert_true((select not autofail and original_autofail and score = 75 from public.v_evaluations_effective where id = public.tid('ev_a2')),
  'autofail overturned and task re-scored to 75');

-- Reopen and reject: score restored
select public.qa_reopen_appeal(public.tid('appeal_af'), 'Calibration disagreed with the reversal.');
select public.qa_decide_appeal(public.tid('appeal_af'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'rejected')) from public.appeal_items where appeal_id = public.tid('appeal_af')),
  'Autofail upheld after calibration review.');
select public.assert_true((select autofail and score = 0 from public.v_evaluations_effective where id = public.tid('ev_a2')), 'reopened + rejected restores autofail (score 0)');
select public.assert_true((select count(*) >= 5 from public.score_adjustments where evaluation_id = public.tid('ev_a2')), 'all adjustments retained append-only');
select public.expect_error($$ delete from public.score_adjustments where evaluation_id = public.tid('ev_a2') $$, '%', 'adjustment history cannot be deleted');
reset session authorization;

-- Direct QA correction outside an appeal
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.admin_adjust_score(public.tid('ev_b1'), '00000000-0000-4000-a000-000000000402', 0, 'short') $$, '%reason%', 'direct correction needs reason');
select public.admin_adjust_score(public.tid('ev_b1'), '00000000-0000-4000-a000-000000000402', 0, 'ATT breach found during calibration');
select public.assert_true((select score = 90 from public.v_evaluations_effective where id = public.tid('ev_b1')), 'direct correction recalculates score');
reset session authorization;

-- Immutability even for the table owner path
select public.expect_error($$ update public.evaluations set original_score = 1 where id = public.tid('ev_b1') $$, '%immutable%', 'original evaluations immutable (owner)');

-- Appeal window enforcement
update public.reporting_periods set published_at = now() - interval '30 days' where id = public.tid('period');
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.submit_appeal(public.tid('ev_b1'), 'Appeal submitted well after the window has closed', '[{"parameter_id":"00000000-0000-4000-a000-000000000402"}]') $$,
  '%appeal window%', 'appeals after the configured window are rejected');
reset session authorization;
update public.reporting_periods set published_at = now() where id = public.tid('period');

-- Notification privacy
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.notifications where recipient_id <> public.tid('cam_b1')), 'users only see their own notifications');
select public.mark_notifications_read(null);
reset session authorization;
select public.assert_true((select count(*) = 0 from public.notifications where recipient_id = public.tid('cam_b1') and read_at is null), 'mark read works');
select public.assert_true((select count(*) > 0 from public.notifications where recipient_id = public.tid('cam_a1') and read_at is null), 'mark read did not touch others');

-- Storage evidence policies
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.expect_error($$ insert into storage.objects (bucket_id, name) values ('appeal-evidence', public.tid('appeal_af')::text || '/x.png') $$,
  '%row-level security%', 'CAM cannot upload evidence to someone else''s appeal');
reset session authorization;
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
insert into public.test_ids select 'appeal_b', public.submit_appeal(public.tid('ev_b1'), 'ATT was within the interruptible 3-hour window for this AR.', '[{"parameter_id":"00000000-0000-4000-a000-000000000402","requested_score":10}]');
insert into storage.objects (bucket_id, name) values ('appeal-evidence', public.tid('appeal_b')::text || '/notes.png');
select public.register_appeal_evidence(public.tid('appeal_b'), public.tid('appeal_b')::text || '/notes.png', 'notes.png', 'image/png', 2048);
select public.expect_error($$ select public.register_appeal_evidence(public.tid('appeal_b'), public.tid('appeal_b')::text || '/evil.exe', 'evil.exe', 'application/x-msdownload', 2048) $$,
  '%not allowed%', 'disallowed file types rejected');
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from storage.objects where name like public.tid('appeal_b')::text || '/%'), 'other CAM cannot read evidence');
reset session authorization;
select public.test_as('lead.b@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 1 from storage.objects where name like public.tid('appeal_b')::text || '/%'), 'CAM''s Lead can read evidence');
reset session authorization;

-- SLA: overdue flag
update public.appeals set status_changed_at = now() - interval '10 days' where id = public.tid('appeal_b');
select public.assert_true((select overdue from public.v_appeals where id = public.tid('appeal_b')), 'overdue flag raised past Lead SLA');
select public.assert_true(public.appeal_sla_sweep() >= 1, 'SLA sweep sends reminders');
select public.assert_true(public.appeal_sla_sweep() = 0, 'SLA sweep does not repeat reminders');

\echo '--- all assertions passed ---'
