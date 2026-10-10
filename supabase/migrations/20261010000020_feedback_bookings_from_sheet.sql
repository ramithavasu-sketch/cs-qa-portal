-- =============================================================================
-- Bookings from the "Booked Sessions" tab of the Feedback Sessions sheet (Setmore
-- bookings: Date, CAM Name, Provider Name, Session Status). The sheet script sends
-- the rows; each row updates that CAM's session in the latest cycle released on or
-- before the session date. CAMs are matched by full name, or by first name when
-- the provider also matches. A completed session is never moved back.
-- Safe to run more than once.
-- =============================================================================
alter table public.feedback_sessions add column if not exists booking_source text;   -- 'cam', 'qa' or 'sheet'

create or replace function public.ingest_feedback_bookings(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; v_at timestamptz; v_name text; v_prov text; v_status text; v_sess uuid; v_cur text;
  n_upd int := 0; n_same int := 0; unmatched jsonb := '[]'::jsonb;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin v_at := (r ->> 'date')::timestamptz; exception when others then v_at := null; end;
    v_name := lower(regexp_replace(trim(coalesce(r ->> 'cam_name', '')), '\s+', ' ', 'g'));
    v_prov := lower(split_part(trim(coalesce(r ->> 'provider_name', '')), ' ', 1));
    v_status := lower(trim(coalesce(r ->> 'status', '')));
    if v_at is null or v_name = '' then continue; end if;

    -- this CAM's session in the latest cycle released by the session date
    select s.id, s.status into v_sess, v_cur
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
    elsif v_status like '%complete%' then
      update public.feedback_sessions set status = 'completed', completed_at = coalesce(completed_at, v_at), booked_for = v_at,
             booking_source = 'sheet', updated_at = now() where id = v_sess;
      n_upd := n_upd + 1;
    elsif v_status like '%cancel%' then
      update public.feedback_sessions set status = 'not_booked', booked_for = null, booked_at = null, booking_source = 'sheet', updated_at = now()
       where id = v_sess and status = 'booked' and booked_for = v_at;   -- only clears the booking this row made
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    elsif v_status like '%no%show%' then
      update public.feedback_sessions set status = 'cancelled', booked_for = v_at, booking_source = 'sheet', updated_at = now()
       where id = v_sess and status is distinct from 'cancelled';
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    else   -- booked / confirmed / pending / blank
      update public.feedback_sessions set status = 'booked', booked_for = v_at, booked_at = coalesce(booked_at, now()), booking_source = 'sheet', updated_at = now()
       where id = v_sess and (status <> 'booked' or booked_for is distinct from v_at);
      if found then n_upd := n_upd + 1; else n_same := n_same + 1; end if;
    end if;
    v_sess := null; v_cur := null;
  end loop;
  return jsonb_build_object('updated', n_upd, 'unchanged', n_same, 'unmatched', unmatched);
end $$;
revoke execute on function public.ingest_feedback_bookings(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_feedback_bookings(jsonb) to service_role;

-- record who set a booking
create or replace function public.mark_feedback_booked(p_session uuid, p_when timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare s public.feedback_sessions;
begin
  select * into s from public.feedback_sessions where id = p_session;
  if s.id is null then raise exception 'Feedback session not found'; end if;
  if s.cam_id is distinct from public.my_employee_id() and not public.is_qa() then
    raise exception 'Only the CAM (or QA) can record this booking' using errcode = '42501';
  end if;
  if s.status = 'completed' then raise exception 'This feedback session is already completed'; end if;
  if p_when is null then raise exception 'Enter the date and time you booked'; end if;
  update public.feedback_sessions set status = 'booked', booked_for = p_when, booked_at = now(), updated_at = now(),
         booking_source = case when s.cam_id = public.my_employee_id() then 'cam' else 'qa' end
   where id = p_session;
end $$;

-- sessions list now says where the booking came from
drop function if exists public.list_feedback_sessions(uuid);
create function public.list_feedback_sessions(p_cycle uuid default null)
returns table (id uuid, cycle_id uuid, cycle_number int, book_by date, cam_id uuid, cam_name text, cam_email text,
               lead_id uuid, lead_name text, provider_id uuid, provider_name text, provider_auto boolean, weeks jsonb,
               status text, booked_for timestamptz, booked_at timestamptz, completed_at timestamptz, booking_source text)
language sql stable security definer set search_path = public as $$
  select s.id, s.cycle_id, c.number, c.book_by, s.cam_id, cam.full_name, cam.email, s.lead_id, ld.full_name,
         s.provider_id, s.provider_name, s.provider_auto, s.weeks, s.status, s.booked_for, s.booked_at, s.completed_at, s.booking_source
  from public.feedback_sessions s
  join public.feedback_cycles c on c.id = s.cycle_id
  join public.employees cam on cam.id = s.cam_id
  left join public.employees ld on ld.id = s.lead_id
  where (p_cycle is null or s.cycle_id = p_cycle)
    and (public.is_qa()
         or (c.released_at is not null
             and (s.cam_id in (select public.my_visible_cam_ids()) or s.lead_id = public.my_employee_id())))
  order by c.number desc, cam.full_name
$$;
revoke execute on function public.list_feedback_sessions(uuid) from public, anon;
grant execute on function public.list_feedback_sessions(uuid) to authenticated;
