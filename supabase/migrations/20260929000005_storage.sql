-- =============================================================================
-- Private bucket for appeal evidence. Path convention: '<appeal_id>/<file>'.
-- Only people who can view the appeal can read; only the appeal's CAM, Lead or
-- QA can upload while the appeal is open. 10 MB limit, images/PDF/text only.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('appeal-evidence', 'appeal-evidence', false, 10485760,
        array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

create or replace function public.evidence_appeal_id(p_name text)
returns uuid language plpgsql immutable as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end $$;
grant execute on function public.evidence_appeal_id(text) to authenticated;

create policy evidence_read on storage.objects for select to authenticated using (
  bucket_id = 'appeal-evidence' and public.can_view_appeal(public.evidence_appeal_id(name))
);

create policy evidence_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'appeal-evidence'
  and public.can_view_appeal(public.evidence_appeal_id(name))
  and exists (
    select 1 from public.appeals a
    where a.id = public.evidence_appeal_id(name)
      and a.status not in ('approved', 'partially_approved', 'rejected', 'closed')
  )
);

-- Registers an uploaded file against the appeal (metadata row + timeline event).
create or replace function public.register_appeal_evidence(p_appeal uuid, p_path text, p_file_name text, p_mime text, p_size int)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me public.employees := public._me();
  v_id uuid;
begin
  if not public.can_view_appeal(p_appeal) then raise exception 'Not authorised' using errcode = '42501'; end if;
  if public.evidence_appeal_id(p_path) is distinct from p_appeal then raise exception 'Evidence path does not match the appeal'; end if;
  if p_mime not in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception 'File type % is not allowed', p_mime;
  end if;
  if p_size <= 0 or p_size > 10485760 then raise exception 'Files must be 10 MB or smaller'; end if;
  insert into public.appeal_evidence (appeal_id, storage_path, file_name, mime_type, size_bytes, uploaded_by)
  values (p_appeal, p_path, p_file_name, p_mime, p_size, me.id) returning id into v_id;
  perform public._appeal_event(p_appeal, me, 'evidence_added', 'Attached ' || p_file_name, 'shared', null, null);
  return v_id;
end $$;
revoke execute on function public.register_appeal_evidence(uuid, text, text, text, int) from public, anon;
grant execute on function public.register_appeal_evidence(uuid, text, text, text, int) to authenticated;
