-- Weekly report emails + team mapping (runs after 10_security_and_workflow.sql, reusing its fixtures)
set client_min_messages = notice;

select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.publish_due_periods() $$, '%Not authorised%', 'CAM cannot run the publish job');
select public.expect_error($$ select * from public.weekly_email_preview(public.tid('period')) $$, '%Only QA%', 'CAM cannot preview weekly emails');
select public.expect_error($$ select public.queue_weekly_report_emails(public.tid('period')) $$, '%Only QA%', 'CAM cannot send weekly emails');
select public.expect_error($$ select public.import_team_mapping('[]') $$, '%Only QA%', 'CAM cannot import team mapping');
reset session authorization;
select public.test_as('lead.a@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.queue_weekly_report_emails(public.tid('period')) $$, '%Only QA%', 'Lead cannot send weekly emails');
reset session authorization;

select public.test_as('qa@test.co'); set session authorization authenticated;
update public.settings set value = value || '{"portal_url": ""}'::jsonb where key = 'notifications';
select public.expect_error($$ select public.queue_weekly_report_emails(public.tid('period')) $$, '%portal URL%', 'portal URL required before emailing');
update public.settings set value = value || '{"portal_url": "https://qa.example.com"}'::jsonb where key = 'notifications';
select public.set_period_status(public.tid('period'), 'draft');
select public.expect_error($$ select public.queue_weekly_report_emails(public.tid('period')) $$, '%Publish%', 'cannot email an unpublished week');
select public.set_period_status(public.tid('period'), 'published');
select public.assert_true((select count(*) = 4 from public.weekly_email_preview(public.tid('period'))), 'preview lists every CAM audited that week');
select public.assert_true((select lead_email = 'lead.a@test.co' from public.weekly_email_preview(public.tid('period')) where cam_email = 'cam.a1@test.co'), 'preview shows Lead CC');
select public.assert_true((select (public.queue_weekly_report_emails(public.tid('period')) ->> 'queued')::int = 4), 'one email queued per CAM');
select public.assert_true((select (public.queue_weekly_report_emails(public.tid('period')) ->> 'skipped')::int = 4), 'already-sent CAMs skipped on repeat');
select public.assert_true((select (public.queue_weekly_report_emails(public.tid('period'), array[public.tid('cam_a1')], true) ->> 'queued')::int = 1), 'resend to a single CAM');
reset session authorization;

select public.assert_true((select count(*) = 5 from public.email_outbox where kind = 'weekly_report'), 'outbox holds 5 weekly emails');
select public.assert_true((select cc_email = 'lead.a@test.co' and subject = 'CS QA Report WK-39 | Cam A1' from public.email_outbox
  where kind = 'weekly_report' and recipient_email = 'cam.a1@test.co' limit 1), 'To CAM, CC Lead, subject rendered');
select public.assert_true((select body_html like '%href="https://qa.example.com/#/?mode=week&amp;period=%' and body_html like '%Quality Assurance Report%'
  and body_html like '%WK-39 (09/24–09/30/2026)%' from public.email_outbox where kind = 'weekly_report' limit 1), 'body has hyperlinked report and week range');
select public.assert_true((select bool_and(body_text not like '%95%' and body_text not like '%85%') from public.email_outbox where kind = 'weekly_report'), 'email carries no scores');

select public.test_as('cam.a1@test.co'); set session authorization authenticated;
select public.assert_true((select count(*) = 0 from public.weekly_report_emails), 'CAM cannot read the email log');
reset session authorization;

-- mapping import
select public.test_as('qa@test.co'); set session authorization authenticated;
create temp table map_res as select public.import_team_mapping('[
  {"cam_email":"cam.b1@test.co","lead_email":"lead.a@test.co","team":"Team Alpha"},
  {"cam_email":"brand.new@test.co","cam_name":"Brand New","lead_email":"new.lead@test.co","lead_name":"New Lead"},
  {"cam_email":"","lead_email":"x@test.co"}]'::jsonb) as r;
select public.assert_true((select (r ->> 'reassigned')::int = 1 and (r ->> 'new_leads')::int = 1 and (r ->> 'new_teams')::int = 1 and (r ->> 'new_cams')::int = 1 and (r ->> 'rejected')::int = 1 from map_res), 'mapping import counts');
reset session authorization;
select public.assert_true((select t.name = 'Team Alpha' from public.employees e join public.teams t on t.id = e.team_id where e.email = 'cam.b1@test.co'), 'CAM moved to mapped team');
select public.assert_true((select l.role = 'admin' and t.name = 'Team New Lead' from public.employees c join public.teams t on t.id = c.team_id join public.employees l on l.id = t.lead_id where c.email = 'brand.new@test.co'), 'new Lead created as Admin with own team');
\echo '--- weekly email + mapping assertions passed ---'
