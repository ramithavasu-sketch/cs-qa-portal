-- CAM (or QA): remove a booking recorded by mistake or cancelled in Setmore. Safe to run more than once.
create or replace function public.clear_feedback_booking(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.feedback_sessions;
begin
  select * into s from public.feedback_sessions where id = p_session;
  if s.id is null then raise exception 'Feedback session not found'; end if;
  if s.cam_id is distinct from public.my_employee_id() and not public.is_qa() then
    raise exception 'Only the CAM (or QA) can remove this booking' using errcode = '42501';
  end if;
  if s.status <> 'booked' then raise exception 'There is no booking to remove'; end if;
  update public.feedback_sessions set status = 'not_booked', booked_for = null, booked_at = null, updated_at = now() where id = p_session;
end $$;
revoke execute on function public.clear_feedback_booking(uuid) from public, anon;
grant execute on function public.clear_feedback_booking(uuid) to authenticated;
