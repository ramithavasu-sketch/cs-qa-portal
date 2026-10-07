-- Gap fixes from the October 2026 review (migration 20261007000008). Runs after 10–30, reusing their fixtures.
set client_min_messages = notice;

-- ---------- a closed appeal no longer blocks a new one on the same parameter
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.submit_appeal(public.tid('ev_a1'), 'Checklist appeal again while the decision stands', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]') $$,
  '%already exists%', 'decided (not closed) appeal still blocks a new appeal');
reset session authorization;
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.close_appeal(public.tid('appeal1'), 'Closed after calibration');
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
insert into public.test_ids select 'appeal_new', public.submit_appeal(public.tid('ev_a1'),
  'New appeal on the checklist after the earlier appeal was closed by QA.', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]');
select public.assert_true(public.tid('appeal_new') is not null, 'closed appeal allows resubmission');
reset session authorization;
select public.assert_true(exists (select 1 from public.notifications where recipient_id = public.tid('cam_a1') and type = 'appeal_submitted'
  and appeal_id = public.tid('appeal_new') and message like '%Task: t-1%' and message like '%Status:%'), 'CAM receives a submission receipt with task id and status');
select public.test_as('cam.a1@test.co'); set session authorization authenticated;

-- ---------- drafts can be edited; the weekly limit also applies when a draft is submitted
insert into public.test_ids select 'draft1', public.submit_appeal(public.tid('ev_a1'),
  'Draft about the email structure parameter for this task.', '[{"parameter_id":"00000000-0000-4000-a000-000000000105"}]', true);
select public.update_draft_appeal(public.tid('draft1'), 'Draft now about required documentation instead, with more detail.',
  '[{"parameter_id":"00000000-0000-4000-a000-000000000104","requested_score":10}]');
select public.assert_true((select count(*) = 1 and bool_and(parameter_id = '00000000-0000-4000-a000-000000000104') from public.appeal_items where appeal_id = public.tid('draft1')),
  'draft items replaced on edit');
select public.assert_true((select reason like 'Draft now about%' from public.appeals where id = public.tid('draft1')), 'draft reason updated');
select public.expect_error($$ select public.update_draft_appeal(public.tid('appeal_new'), 'Trying to edit a submitted appeal reason text', '[{"parameter_id":"00000000-0000-4000-a000-000000000106"}]') $$,
  '%Only drafts%', 'submitted appeals cannot be edited');
reset session authorization;
update public.settings set value = value || '{"max_appeals_per_cam_per_period": 1}'::jsonb where key = 'appeal_window';
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.submit_draft_appeal(public.tid('draft1')) $$, '%maximum%', 'weekly limit enforced when a draft is submitted');
reset session authorization;
update public.settings set value = value || '{"max_appeals_per_cam_per_period": null}'::jsonb where key = 'appeal_window';
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.update_draft_appeal(public.tid('draft1'), 'Another CAM editing somebody else''s draft', '[{"parameter_id":"00000000-0000-4000-a000-000000000104"}]') $$,
  '%Not authorised%', 'other CAM cannot edit a draft');
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.submit_draft_appeal(public.tid('draft1'));
select public.assert_true((select status = 'pending_lead_review' from public.appeals where id = public.tid('draft1')), 'draft submitted after limit lifted');
reset session authorization;

-- ---------- internal comments can be shared with the CAM by their author (or QA)
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.add_appeal_comment(public.tid('appeal_new'), 'Internal: evidence looks plausible, checking with QA.', true);
reset session authorization;
insert into public.test_ids select 'ev_internal', id from public.appeal_events where appeal_id = public.tid('appeal_new') and visibility = 'internal' and action = 'comment';
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.appeal_events where id = public.tid('ev_internal')), 'CAM cannot see the internal comment yet');
select public.expect_error($$ select public.share_appeal_comment(public.tid('ev_internal')) $$, '%', 'CAM cannot share internal comments');
reset session authorization;
select public.test_as('lead.b@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.share_appeal_comment(public.tid('ev_internal')) $$, '%Not authorised%', 'another team''s Lead cannot share it');
reset session authorization;
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.share_appeal_comment(public.tid('ev_internal'));
reset session authorization;
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 1 from public.appeal_events where id = public.tid('ev_internal')), 'CAM sees the comment once shared');
reset session authorization;

-- ---------- QA must give a reason per approved parameter; reopen clears the old decision
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.lead_review_appeal(public.tid('appeal_new'), 'recommend_approval', 'Agree with the CAM, checklist evidence attached.');
reset session authorization;
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.qa_decide_appeal(public.tid('appeal_new'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 5)) from public.appeal_items where appeal_id = public.tid('appeal_new')),
  'Approved after reviewing the evidence.') $$, '%reason for the score adjustment%', 'approved parameter needs its own reason');
select public.qa_decide_appeal(public.tid('appeal_new'),
  (select jsonb_agg(jsonb_build_object('item_id', id, 'decision', 'approved', 'revised_score', 5, 'reason', 'Half of the checklist was completed')) from public.appeal_items where appeal_id = public.tid('appeal_new')),
  'Approved in part after reviewing the evidence.');
select public.qa_reopen_appeal(public.tid('appeal_new'), 'Reopened to recheck the checklist evidence.');
select public.assert_true((select decided_at is null and decided_by is null and resolution_note is null from public.appeals where id = public.tid('appeal_new')), 'reopen clears the previous decision fields');
select public.assert_true((select bool_and(decision = 'pending' and decided_by is null) from public.appeal_items where appeal_id = public.tid('appeal_new')), 'reopen resets item decisions');
reset session authorization;
select public.assert_true(exists (select 1 from public.audit_logs where action = 'appeal_qa_decided' and record_id = public.tid('appeal_new')::text and reason like 'Approved in part%'),
  'appeal decision logged with its reason');
select public.assert_true(exists (select 1 from public.audit_logs where action = 'appeal_submitted' and record_id = public.tid('appeal_new')::text), 'appeal submission logged');
select public.assert_true(not exists (select 1 from public.notifications where appeal_id in (public.tid('appeal_new'), public.tid('draft1'))
  and (message not like '%Task:%' or message not like '%Status:%')), 'every appeal notification includes task id and status');
select public.assert_true(exists (select 1 from public.audit_logs where action = 'appeal_item_decision' and reason = 'Half of the checklist was completed'), 'item decision logged');

-- ---------- server-side validation
select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ update public.settings set value = '{"green": 80, "amber": 90}' where key = 'thresholds' $$, '%amber at or below green%', 'thresholds validated');
select public.expect_error($$ update public.settings set value = value || '{"week_start_dow": 9}' where key = 'reporting' $$, '%Monday%', 'week start day validated');
select public.expect_error($$ update public.settings set value = value || '{"portal_url": "javascript:alert(1)"}' where key = 'notifications' $$, '%Portal URL%', 'portal URL validated');
select public.expect_error($$ update public.teams set lead_id = public.tid('cam_a2') where lead_id = public.tid('lead_a') $$, '%active Admin%', 'a CAM cannot be made Team Lead');
select public.expect_error($$ update public.employees set role = 'admin' where id = public.tid('qa') $$, '%own Super Admin%', 'QA cannot demote themselves');
select public.expect_error($$ update public.employees set role = 'user' where id = public.tid('lead_a') $$, '%leads a team%', 'a Lead with a team cannot become a CAM');
select public.expect_error($$ insert into public.employees (email, full_name, role) values ('not-an-email', 'Bad Email', 'user') $$, '%email_format%', 'employee email format validated');
select public.expect_error($$ update public.reporting_periods set status = 'draft' where id = public.tid('period') $$, '%Publish / Unpublish%', 'week status only changes via Publish / Unpublish');
select public.expect_error($$ insert into public.reporting_periods (label, short_label, year, week_number, start_date, end_date, status)
  values ('WK-50 : 2026 (12/10- 12/16)', 'WK-50', 2026, 50, '2026-12-10', '2026-12-16', 'published') $$, '%start as drafts%', 'new weeks cannot be created published');
reset session authorization;
select public.test_as('stranger@test.co'); -- server-side path (e.g. the admin-users function): no signed-in employee
select public.expect_error($$ update public.employees set status = 'inactive' where id = public.tid('qa') $$, '%last active Super Admin%', 'last active Super Admin cannot be deactivated');

-- ---------- export logging
select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.log_report_export('Cam A1', 'WK-39', 'pdf');
select public.expect_error($$ select public.log_report_export('Cam A1', 'WK-39', 'exe') $$, '%Unknown format%', 'export format validated');
reset session authorization;
select public.assert_true(exists (select 1 from public.audit_logs where action = 'report_export' and actor_id = public.tid('cam_a1')), 'report download written to audit log');

-- ---------- weekly report notifications: link works; recent weeks created already published notify; old back-fills do not
select public.assert_true(not exists (select 1 from public.notifications where link like '/dashboard%'), 'report links point to an existing route');
select public.assert_true(not exists (select 1 from public.notifications n join public.reporting_periods rp on n.link like '%period=' || rp.id::text
  where rp.year = 2022), 'archive back-fill into old weeks sends no report notifications');
select public.test_as('qa@test.co'); set session authorization authenticated;
create temp table imp40 as select public.import_evaluations(jsonb_build_object('source', 'csv', 'file_name', 'wk', 'publish_new_periods', true, 'rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'task_link', 'https://ds.test/crm#task/t-40', 'task_id', 't-40', 'cam_email', 'cam.a2@test.co', 'task_type', 'INTERNAL',
      'audited_at', now()::text, 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-41 : 2026 (10/08- 10/14)', 'short_label', 'WK-41', 'year', 2026, 'week', 41,
        'start', (current_date - 3)::text, 'end', (current_date + 3)::text),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10)))))) as r;
reset session authorization;
select public.assert_true((select (r ->> 'inserted')::int = 1 from imp40), 'import into a new published week');
select public.assert_true((select count(*) = 1 from public.notifications n join public.reporting_periods rp on n.link = '/?mode=week&period=' || rp.id
  where rp.short_label = 'WK-41' and n.recipient_id = public.tid('cam_a2') and n.type = 'report_published'), 'CAM notified for a week imported as published');

-- ---------- scheduled weekly publishing follows reporting.auto_publish*
select public.test_as('qa@test.co'); set session authorization authenticated;
create temp table imp41 as select public.import_evaluations(jsonb_build_object('source', 'csv', 'file_name', 'wk38', 'publish_new_periods', false, 'rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'task_link', 'https://ds.test/crm#task/t-38', 'task_id', 't-38', 'cam_email', 'cam.b1@test.co', 'task_type', 'INTERNAL',
      'audited_at', '2026-09-20T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-38 : 2026 (09/17- 09/23)', 'short_label', 'WK-38', 'year', 2026, 'week', 38, 'start', '2026-09-17', 'end', '2026-09-23'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10)))))) as r;
reset session authorization;
select public.assert_true((select status = 'draft' from public.reporting_periods where short_label = 'WK-38' and year = 2026), 'WK-38 imported as draft');
select public.publish_due_periods();
select public.assert_true((select status = 'draft' from public.reporting_periods where short_label = 'WK-38' and year = 2026), 'no auto-publish while the schedule is off');
update public.settings set value = value || '{"auto_publish": true, "auto_publish_dow": 1, "auto_publish_time": "10:00"}'::jsonb where key = 'reporting';
select public.assert_true(public.publish_due_periods() >= 1, 'schedule publishes due draft weeks');
select public.assert_true((select status = 'published' from public.reporting_periods where short_label = 'WK-38' and year = 2026), 'WK-38 published on schedule');
update public.settings set value = value || '{"auto_publish": false}'::jsonb where key = 'reporting';

-- ---------- due-soon reminder before the review target
update public.appeals set status_changed_at = now() - interval '36 hours' where id = public.tid('draft1');
select public.appeal_sla_sweep();
select public.assert_true(exists (select 1 from public.notifications where appeal_id = public.tid('draft1') and type = 'appeal_due_soon' and recipient_id = public.tid('lead_a')),
  'Lead warned before the review target is missed');

-- ---------- e-mail switches are independent of in-app switches
update public.settings set value = value || '{"email_enabled": true, "in_app": {"score_changed": false}, "email": {"score_changed": true}}'::jsonb where key = 'notifications';
select public.notify(public.tid('cam_a1'), 'score_changed', 'Email-only check t-1', 'A finalized score was changed.', '/evaluations/x', null);
select public.assert_true(exists (select 1 from public.email_outbox where subject = '[CS QA Portal] Email-only check t-1'), 'email still sent with in-app off');
select public.assert_true(not exists (select 1 from public.notifications where title = 'Email-only check t-1' and created_at > now() - interval '1 minute'), 'in-app suppressed');

\echo '--- brief-gap assertions passed ---'
