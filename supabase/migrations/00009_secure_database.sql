-- ============================================================================
-- Migration 00009: Security hardening (whole-database)
-- Fixes:
--   1. Drops unused SECURITY DEFINER view public.public_profiles (PII leak).
--   2. Pins search_path on all helper functions (prevents search-path hijack).
--   3. Makes ID-photo / signature buckets PRIVATE; scopes storage policies to
--      owners and admins (PII protection for anonymous users).
--   4. Scopes ticket-attachment storage access to ticket participants/admins.
--   5. Removes forged-audit-log capability for arbitrary authenticated users.
--   6. Revokes anon (unauthenticated) direct table/sequence privileges.
-- ============================================================================

begin;

-- ── 1. Remove unused SECURITY DEFINER view ───────────────────────────────────
-- The app reads public.profiles via PostgREST + RLS, never this view.
drop view if exists public.public_profiles;

-- ── 2. Pin search_path on SECURITY DEFINER / helper functions ───────────────
-- All table references below are fully qualified, so an empty search_path is safe.

create or replace function public.touch_id_request()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.get_my_role()
returns text language sql security definer stable set search_path = '' as $$
  select role::text from public.profiles where id = auth.uid() limit 1;
$$;

create or replace function public.is_ict_admin()
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('it_admin','sysadmin')
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, username, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'requester')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.get_user_role(uid uuid)
returns public.user_role language sql security definer stable set search_path = '' as $$
  select role from public.profiles where id = uid;
$$;

create or replace function public.is_admin(uid uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select role in ('it_admin', 'sysadmin') from public.profiles where id = uid;
$$;

create or replace function public.is_sysadmin(uid uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select role = 'sysadmin' from public.profiles where id = uid;
$$;

create or replace function public.ticket_requester(ticket_id uuid)
returns uuid language sql security definer stable set search_path = '' as $$
  select requester_id from public.tickets where id = ticket_id;
$$;

create or replace function public.ticket_assigned_to(ticket_id uuid)
returns uuid language sql security definer stable set search_path = '' as $$
  select assigned_to from public.tickets where id = ticket_id;
$$;

-- Trigger helpers (SECURITY INVOKER): still pin search_path, fully-qualified bodies.
create or replace function public.generate_ticket_number()
returns trigger language plpgsql set search_path = '' as $$
declare
  yr text;
  seq_val bigint;
begin
  yr := to_char(now(), 'YYYY');
  seq_val := nextval('public.ticket_seq');
  new.ticket_number := 'TKT-' || yr || '-' || lpad(seq_val::text, 5, '0');
  return new;
end;
$$;

create or replace function public.update_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.set_sla_due()
returns trigger language plpgsql set search_path = '' as $$
declare
  sla_h int;
begin
  select sla_hours into sla_h from public.priority_config where priority = new.priority;
  if sla_h is not null then
    new.sla_due_at := now() + (sla_h || ' hours')::interval;
  end if;
  return new;
end;
$$;

create or replace function public.set_auto_close()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'verified' and (old.status is distinct from 'verified') then
    new.auto_close_at := now() + interval '48 hours';
  end if;
  if new.status != 'verified' then
    new.auto_close_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── 3. Storage: make PII buckets PRIVATE + scope policies ────────────────────
-- ID photos and signatures are never public. Files live under <user_id>/... so
-- storage.foldername(name)[1] resolves to the owning user's id.
update storage.buckets
  set public = false
  where id in ('id-photos', 'id-signatures');

-- Replace broad id-photos policies with owner/admin-scoped ones.
drop policy if exists "id_photos_insert" on storage.objects;
create policy "id_photos_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'id-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "id_photos_select" on storage.objects;
create policy "id_photos_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'id-photos'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.get_my_role() in ('it_admin', 'sysadmin')
    )
  );

drop policy if exists "id_signatures_insert" on storage.objects;
create policy "id_signatures_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'id-signatures'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "id_signatures_select" on storage.objects;
create policy "id_signatures_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'id-signatures'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.get_my_role() in ('it_admin', 'sysadmin')
    )
  );

-- ── 4. Storage: ticket attachments scoped to participants/admins ────────────
-- Attachment paths are <ticket_id>/<name>. Only requester, assigned tech, or
-- admins may read/upload the objects.
drop policy if exists "Authenticated access attachments" on storage.objects;
create policy "Authenticated access attachments" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ticket-attachments'
    and exists (
      select 1 from public.tickets t
      where t.id::text = (storage.foldername(name))[1]
        and (
          t.requester_id = auth.uid()
          or t.assigned_to = auth.uid()
          or public.is_admin(auth.uid())
        )
    )
  );

drop policy if exists "Authenticated upload attachments" on storage.objects;
create policy "Authenticated upload attachments" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ticket-attachments'
    and exists (
      select 1 from public.tickets t
      where t.id::text = (storage.foldername(name))[1]
        and (
          t.requester_id = auth.uid()
          or t.assigned_to = auth.uid()
          or public.is_admin(auth.uid())
        )
    )
  );

-- ── 5. Audit log: only service_role (edge functions) may write ──────────────
-- service_role bypasses RLS, so dropping this user-write policy keeps the
-- edge functions working while removing the ability to forge audit entries.
drop policy if exists "System inserts audit log" on public.audit_log;

-- ── 6. Revoke direct table/sequence privileges from anon ───────────────────
-- All client access goes through the authenticated role (RLS-enforced). anon
-- needs no direct table privileges; this is defense-in-depth.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Also stop future objects from auto-granting to anon (Supabase's default
-- privileges give ALL to anon/authenticated on newly created tables).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

commit;