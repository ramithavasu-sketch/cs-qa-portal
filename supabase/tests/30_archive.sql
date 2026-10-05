-- Archived audits: legacy rubric + name-only CAMs + merge
set client_min_messages = notice;
select public.test_as('qa@test.co'); set session authorization authenticated;
create temp table arch as select public.import_evaluations(jsonb_build_object('source', 'google_sheets', 'file_name', 'Archived Data 2022', 'publish_new_periods', true,
  'rows', jsonb_build_array(
    -- legacy Chat rubric (2022-23), name-only CAM
    jsonb_build_object('row_number', 2, 'task_link', 'https://ds.test/crm#task/old-1', 'cam_email', '', 'cam_name', 'Cam A1', 'task_type', 'CHAT',
      'audited_at', '2022-07-01T10:00:00Z', 'autofail', false, 'score', 85,
      'period', jsonb_build_object('label', 'WK-27 : 2022 (06/26 - 07/02)', 'short_label', 'WK-27', 'year', 2022, 'week', 27, 'start', '2022-06-26', 'end', '2022-07-02'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000501', 'earned', 30),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000502', 'earned', 0),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000503', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000504', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000505', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000506', 'earned', 15),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000507', 'earned', 10))),
    -- name-only CAM not in the directory -> historical record
    jsonb_build_object('row_number', 3, 'task_link', 'https://ds.test/crm#task/old-2', 'cam_email', '', 'cam_name', 'Pranoy', 'task_type', 'INTERNAL',
      'audited_at', '2022-07-01T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-27 : 2022 (06/26 - 07/02)', 'short_label', 'WK-27', 'year', 2022, 'week', 27, 'start', '2022-06-26', 'end', '2022-07-02'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10))),
    -- mixing rubric versions is rejected
    jsonb_build_object('row_number', 4, 'task_link', 'https://ds.test/crm#task/old-3', 'cam_email', '', 'cam_name', 'Pranoy', 'task_type', 'CHAT',
      'audited_at', '2022-07-01T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-27 : 2022 (06/26 - 07/02)', 'short_label', 'WK-27', 'year', 2022, 'week', 27, 'start', '2022-06-26', 'end', '2022-07-02'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000501', 'earned', 30),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000202', 'earned', 10))),
    -- incomplete legacy rubric is rejected
    jsonb_build_object('row_number', 5, 'task_link', 'https://ds.test/crm#task/old-4', 'cam_email', '', 'cam_name', 'Pranoy', 'task_type', 'CHAT',
      'audited_at', '2022-07-01T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-27 : 2022 (06/26 - 07/02)', 'short_label', 'WK-27', 'year', 2022, 'week', 27, 'start', '2022-06-26', 'end', '2022-07-02'),
      'scores', jsonb_build_array(jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000501', 'earned', 30)))
  ))) as r;
select public.assert_true((select (r ->> 'inserted')::int = 2 and (r ->> 'rejected')::int = 2 from arch), 'archive import: 2 inserted, 2 rejected');
select public.assert_true(exists (select 1 from public.import_rejections where reason = 'Scores must come from exactly one rubric version'), 'mixed rubric versions rejected');
select public.assert_true(exists (select 1 from public.import_rejections where reason like '6 scoring parameter(s) missing%'), 'incomplete legacy rubric rejected');
select public.assert_true((select cam_email = 'cam.a1@test.co' from public.v_evaluations_effective where task_link = 'https://ds.test/crm#task/old-1'), 'name matching an existing CAM exactly is linked to that CAM');
select public.assert_true((select score = 85 from public.v_evaluations_effective where task_link = 'https://ds.test/crm#task/old-1'), 'legacy rubric score stored');
select public.assert_true((select count(*) = 1 from public.historical_cams() where name = 'Pranoy'), 'unknown name becomes a historical record');
reset session authorization;
select public.assert_true((select status = 'inactive' and is_historical and auth_user_id is null from public.employees where full_name = 'Pranoy'), 'historical record cannot sign in');

select public.test_as('cam.b1@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.merge_employee((select id from public.employees where full_name = 'Pranoy'), public.tid('cam_b1')) $$, '%', 'CAM cannot merge records');
reset session authorization;

select public.test_as('qa@test.co'); set session authorization authenticated;
select public.expect_error($$ select public.merge_employee(public.tid('cam_a1'), public.tid('cam_b1')) $$, '%Only historical%', 'real CAMs cannot be merged');
select public.assert_true((select (public.merge_employee((select id from public.employees where full_name = 'Pranoy'), public.tid('cam_b1')) ->> 'moved')::int = 1), 'historical name linked to real CAM');
select public.assert_true((select cam_id = public.tid('cam_b1') from public.evaluations where task_link = 'https://ds.test/crm#task/old-2'), 'archived audit now belongs to the CAM');
-- re-import of the same name goes straight to the linked CAM (alias)
create temp table arch2 as select public.import_evaluations(jsonb_build_object('source', 'csv', 'file_name', 'x', 'publish_new_periods', true, 'rows', jsonb_build_array(
    jsonb_build_object('row_number', 2, 'task_link', 'https://ds.test/crm#task/old-5', 'cam_email', '', 'cam_name', 'pranoy', 'task_type', 'INTERNAL',
      'audited_at', '2022-07-02T10:00:00Z', 'autofail', false, 'score', 100,
      'period', jsonb_build_object('label', 'WK-27 : 2022 (06/26 - 07/02)', 'short_label', 'WK-27', 'year', 2022, 'week', 27, 'start', '2022-06-26', 'end', '2022-07-02'),
      'scores', jsonb_build_array(
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000401', 'earned', 80),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000402', 'earned', 10),
        jsonb_build_object('parameter_id', '00000000-0000-4000-a000-000000000403', 'earned', 10)))))) as r;
select public.assert_true((select cam_id = public.tid('cam_b1') from public.evaluations where task_link = 'https://ds.test/crm#task/old-5'), 'alias remembered for future imports');
reset session authorization;
select public.expect_error($$ update public.evaluations set original_score = 1 where task_link = 'https://ds.test/crm#task/old-5' $$, '%immutable%', 'scores still immutable after merge support');
\echo '--- archive assertions passed ---'
