-- =============================================================================
-- Removing a booking in the portal marks the session Cancelled (the booked time is
-- kept for the record; the CAM can book again). The sheet script writes "Cancelled"
-- into the matching "Booked Sessions" row, and a not-yet-updated sheet row can't
-- re-book a cancelled session. Safe to run more than once.
-- =============================================================================
create or replace function public.clear_feedback_booking(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.feedback_sessions;
begin
  select * into s from public.feedback_sessions where id = p_session;
  if s.id is null then raise exception 'Feedback session not found'; end if;
  if s.cam_id is distinct from public.my_employee_id() and not public.is_qa() then
    raise exception 'Only the CAM (or QA) can cancel this booking' using errcode = '42501';
  end if;
  if s.status <> 'booked' then raise exception 'There is no booking to cancel'; end if;
  update public.feedback_sessions set status = 'cancelled', updated_at = now() where id = p_session;
end $$;

-- p_rows: [{row, date, cam_name, provider_name, status}]; returns the sheet rows to mark "Cancelled".
create or replace function public.ingest_feedback_bookings(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_at timestamptz; v_name text; v_prov text; v_status text; v_sess uuid; v_cur text; v_booked timestamptz;
  n_upd int := 0; n_same int := 0; unmatched jsonb := '[]'::jsonb; to_cancel jsonb := '[]'::jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin v_at := (r ->> 'date')::timestamptz; exception when others then v_at := null; end;
    v_name := lower(regexp_replace(trim(coalesce(r ->> 'cam_name', '')), '\s+', ' ', 'g'));
    v_prov := lower(split_part(trim(coalesce(r ->> 'provider_name', '')), ' ', 1));
    v_status := lower(trim(coalesce(r ->> 'status', '')));
    if v_at is null or v_name = '' then continue; end if;

    select s.id, s.status, s.booked_for into v_sess, v_cur, v_booked
    from public.feedback_sessions s
    join public.feedback_cycles c on c.id = s.cycle_id
    join public.employees cam on cam.id = s.cam_id
    where c.released_at is not null and c.released_at::date <= v_at::date + 1
      and (lower(cam.full_name) = v_name
           or (split_part(lower(cam.full_name), ' ', 1) = split_part(v_name, ' ', 1)
               and lower(split_part(coalesce(s.provider_name, ''), ' ', 1)) = v_prov
               and (select count(*) from public.feedback_sessions s2 join public.employees e2 on e2.id = s2.cam_id
                     where s2.cycle_id = s.cycle_id and split_part(lower(e2.full_name), ' ', 1) = split_part(v_name, ' ', 1)
                       and lower(split_part(coalesce(s2.provider_name, ''), ' ', 1)) = v_prov) = 1))
    order by c.number desc, (lower(cam.full_name) = v_name) desc
    limit 1;

    if v_sess is null then
      unmatched := unmatched || jsonb_build_array(r ->> 'cam_name');
      continue;
    end if;

    if v_cur = 'completed' then
      n_same := n_same + 1;
    elsif v_cur = 'cancelled' and v_booked = v_at and v_status not like '%complete%' then
      -- cancelled in the portal: this sheet row must say so too
      if v_status not like '%cancel%' and r ? 'row' then to_cancel := to_cancel || jsonb_build_array((r ->> 'row')::int); end if;
      n_same := n_same + 1;
    elsif v_status like '%complete%' then
      update public.feedback_sessions set status = 'completed', completed_at = coalesce(completed_at, v_at), booked_for = v_at,
             booking_source = 'sheet', updated_at = now() where id = v_sess;
      n_upd := n_upd + 1;
    elsif v_status like '%cancel%' then
      update public.feedback_sessions set status = 'cancelled', booking_source = 'sheet', updated_at = now()
       where id = v_sess and status = 'booked' and booked_for = v_at;   -- only the booking this row made
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    elsif v_status like '%no%show%' then
      update public.feedback_sessions set status = 'cancelled', booked_for = v_at, booking_source = 'sheet', updated_at = now()
       where id = v_sess and status is distinct from 'cancelled';
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    else   -- booked / confirmed / pending / blank (a new time after a cancellation books again)
      update public.feedback_sessions set status = 'booked', booked_for = v_at, booked_at = coalesce(booked_at, now()), booking_source = 'sheet', updated_at = now()
       where id = v_sess and (status <> 'booked' or booked_for is distinct from v_at);
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    end if;
    v_sess := null; v_cur := null; v_booked := null;
  end loop;
  return jsonb_build_object('updated', n_upd, 'unchanged', n_same, 'unmatched', unmatched, 'cancel_rows', to_cancel);
end $$;
revoke execute on function public.ingest_feedback_bookings(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_feedback_bookings(jsonb) to service_role;
