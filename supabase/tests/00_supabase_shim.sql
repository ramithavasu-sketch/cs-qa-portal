-- Minimal emulation of the Supabase platform objects so the migrations and RLS
-- can be tested on a plain PostgreSQL server (used by scripts/test-db.sh).
-- NOT part of the production migrations.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant select, insert on storage.objects to authenticated;

grant usage on schema public to anon, authenticated, service_role;
