-- =============================================================================
-- Archived audits (2022–2025) identify CAMs by NAME ("Akanksha R"), not email.
-- Such rows are attached to a "historical" CAM record (no login) that QA can later
-- link to the real CAM with merge_employee(); the name is remembered as an alias so
-- future imports go straight to the right person.
-- =============================================================================

alter table public.employees add column if not exists is_historical boolean not null default false;

create table public.employee_aliases (
  alias        text primary key,          -- normalised name as written in the sheet
  employee_id  uuid not null references public.employees (id) on delete cascade,
  source       text not null default 'manual' check (source in ('manual', 'auto', 'merge')),
  created_at   timestamptz not null default now()
);
create index employee_aliases_emp_idx on public.employee_aliases (employee_id);
alter table public.employee_aliases enable row level security;
create policy employee_aliases_select on public.employee_aliases for select to authenticated using (public.is_super_admin());
revoke all on public.employee_aliases from anon, authenticated;
grant select on public.employee_aliases to authenticated;

create or replace function public._name_key(p text)
returns text language sql immutable as $$ select lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')) $$;

-- Alias → unique exact full-name match → new historical record.
create or replace function public._resolve_cam_name(p_name text, p_is_demo boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  k text := public._name_key(p_name);
  v uuid;
  n int;
  v_slug text;
begin
  if k = '' then return null; end if;
  select employee_id into v from public.employee_aliases where alias = k;
  if v is not null then return v; end if;
  select count(*), min(id::text)::uuid into n, v from public.employees where public._name_key(full_name) = k and role = 'user';
  if n = 1 then
    insert into public.employee_aliases (alias, employee_id, source) values (k, v, 'auto') on conflict do nothing;
    return v;
  end if;
  v_slug := regexp_replace(k, '[^a-z0-9]+', '.', 'g');
  insert into public.employees (email, full_name, role, status, is_historical, is_demo)
  values ('historical.' || v_slug || '@cam-email-needed.invalid', trim(p_name), 'user', 'inactive', true, p_is_demo)
  on conflict (email) do nothing
  returning id into v;
  if v is null then select id into v from public.employees where email = 'historical.' || v_slug || '@cam-email-needed.invalid'; end if;
  insert into public.employee_aliases (alias, employee_id, source) values (k, v, 'auto') on conflict do nothing;
  return v;
end $$;

-- Historical names with their audit counts and likely matches (first name + last-name initial vs email).
create or replace function public.historical_cams()
returns table (id uuid, name text, tasks int, first_week text, last_week text, candidates jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super_admin() then raise exception 'Only QA can manage historical names' using errcode = '42501'; end if;
  return query
  select h.id, h.full_name, count(e.id)::int,
         (array_agg(rp.short_label || ' ' || rp.year order by rp.start_date))[1],
         (array_agg(rp.short_label || ' ' || rp.year order by rp.start_date desc))[1],
         coalesce((
           select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.full_name, 'email', c.email) order by c.full_name)
           from public.employees c
           where c.role = 'user' and not c.is_historical
             and split_part(split_part(c.email, '@', 1), '.', 1) = split_part(public._name_key(h.full_name), ' ', 1)
             and (split_part(public._name_key(h.full_name), ' ', 2) = ''
                  or split_part(split_part(c.email, '@', 1), '.', 2) like left(split_part(public._name_key(h.full_name), ' ', 2), 1) || '%')
         ), '[]'::jsonb)
  from public.employees h
  left join public.evaluations e on e.cam_id = h.id
  left join public.reporting_periods rp on rp.id = e.period_id
  where h.is_historical
  group by h.id, h.full_name
  order by count(e.id) desc;
end $$;

-- Moves everything from a historical record onto the real CAM and remembers the name.
create or replace function public.merge_employee(p_from uuid, p_into uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f public.employees; t public.employees; n int;
begin
  if not public.is_super_admin() then raise exception 'Only QA can link historical names' using errcode = '42501'; end if;
  select * into f from public.employees where id = p_from;
  select * into t from public.employees where id = p_into;
  if f.id is null or t.id is null then raise exception 'CAM not found'; end if;
  if not f.is_historical then raise exception 'Only historical (name-only) records can be merged'; end if;
  if f.id = t.id then raise exception 'Choose a different CAM'; end if;
  perform set_config('app.allow_cam_merge', 'on', true);
  update public.evaluations set cam_id = t.id where cam_id = f.id;
  get diagnostics n = row_count;
  perform set_config('app.allow_cam_merge', 'off', true);
  update public.appeals set cam_id = t.id where cam_id = f.id;
  update public.employee_aliases set employee_id = t.id, source = 'merge' where employee_id = f.id;
  insert into public.employee_aliases (alias, employee_id, source) values (public._name_key(f.full_name), t.id, 'merge')
    on conflict (alias) do update set employee_id = excluded.employee_id, source = 'merge';
  insert into public.audit_logs (actor_id, action, table_name, record_id, previous, new_value)
  values (public.my_employee_id(), 'merge_employee', 'employees', t.id::text,
          jsonb_build_object('historical_name', f.full_name, 'historical_id', f.id), jsonb_build_object('into', t.full_name, 'evaluations_moved', n));
  delete from public.employees where id = f.id;
  return jsonb_build_object('moved', n);
end $$;

revoke execute on function public._resolve_cam_name(text, boolean), public.historical_cams(), public.merge_employee(uuid, uuid), public._name_key(text) from public, anon;
grant execute on function public.historical_cams(), public.merge_employee(uuid, uuid) to authenticated;
