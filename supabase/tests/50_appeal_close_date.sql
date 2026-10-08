-- Fixed appeal closing date per week (migration 20261008000009). Runs after 10–40, reusing their fixtures.
set client_min_messages = notice;
reset session authorization;
update public.settings set value = value || '{"max_appeals_per_cam_per_period": null}'::jsonb where key = 'appeal_window';

-- QA sets a closing date in the past for WK-39: no new appeals, and the deadline reflects it
select public.test_as('qa@test.co'); set session authorization authenticated;
update public.reporting_periods set appeal_closes_at = now() - interval '1 hour' where id = public.tid('period');
reset session authorization;
select public.assert_true(abs(extract(epoch from public.appeal_deadline(public.tid('ev_b1')) - (now() - interval '1 hour'))) < 5, 'deadline follows the fixed closing date');
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.submit_appeal(public.tid('ev_b1'), 'Appeal after the fixed closing date for the week', '[{"parameter_id":"00000000-0000-4000-a000-000000000403"}]') $$,
  '%appeal window%', 'appeals after the fixed closing date are rejected');
reset session authorization;

-- A later fixed date reopens the window, even though the normal rule would have closed it
update public.reporting_periods set published_at = now() - interval '60 days' where id = public.tid('period');
select public.test_as('qa@test.co'); set session authorization authenticated;
update public.reporting_periods set appeal_closes_at = now() + interval '2 days' where id = public.tid('period');
reset session authorization;
select public.test_as('cam.b1@test.co'); set session authorization authenticated;
insert into public.test_ids select 'appeal_fixed', public.submit_appeal(public.tid('ev_b1'),
  'Appeal inside the fixed closing date set by QA for this week.', '[{"parameter_id":"00000000-0000-4000-a000-000000000403"}]');
select public.assert_true(public.tid('appeal_fixed') is not null, 'appeal accepted before the fixed closing date');
-- CAMs and Leads cannot move the date
update public.reporting_periods set appeal_closes_at = now() + interval '90 days' where id = public.tid('period'); -- RLS: 0 rows
reset session authorization;
select public.assert_true((select appeal_closes_at < now() + interval '3 days' from public.reporting_periods where id = public.tid('period')), 'CAM cannot change the closing date');

-- Clearing it returns to the normal rule (60 days after publication = closed)
update public.reporting_periods set appeal_closes_at = null where id = public.tid('period');
select public.assert_true(public.appeal_deadline(public.tid('ev_b1')) < now(), 'cleared date falls back to the appeal-window rule');
update public.reporting_periods set published_at = now() where id = public.tid('period');
-- 7 calendar days, closing at 11:59 pm in the portal time zone (Asia/Kolkata)
update public.settings set value = value || '{"days": 7, "business_days": false, "end_of_day": true}'::jsonb where key = 'appeal_window';
update public.settings set value = value || '{"timezone": "Asia/Kolkata"}'::jsonb where key = 'reporting';
update public.reporting_periods set published_at = '2026-10-08 10:00:00+05:30' where id = public.tid('period');
select public.assert_true(public.appeal_deadline(public.tid('ev_b1')) = '2026-10-15 23:59:59+05:30'::timestamptz, 'published 8 Oct 10:00 IST closes 15 Oct 23:59:59 IST');
update public.reporting_periods set published_at = '2026-10-08 23:30:00+05:30' where id = public.tid('period');
select public.assert_true(public.appeal_deadline(public.tid('ev_b1')) = '2026-10-15 23:59:59+05:30'::timestamptz, 'late-evening publication still closes at 23:59 on day 7');
update public.reporting_periods set published_at = now() where id = public.tid('period');
\echo '--- appeal close date assertions passed ---'
