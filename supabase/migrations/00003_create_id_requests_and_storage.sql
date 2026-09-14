
-- ── id_requests table ────────────────────────────────────────────────────────
create table if not exists public.id_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  office_name   text not null,
  full_name     text not null,
  nickname      text,
  id_number     text not null,
  position      text not null,
  address       text not null,
  emergency_name    text not null,
  emergency_contact text not null,
  emergency_address text not null,
  photo_url     text,
  signature_url text,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- auto-update updated_at
create or replace function public.touch_id_request()
returns trigger language plpgsql security definer as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_touch_id_request on public.id_requests;
create trigger trg_touch_id_request
  before update on public.id_requests
  for each row execute procedure public.touch_id_request();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.id_requests enable row level security;

-- helper: check role without self-referencing the table
create or replace function public.get_my_role()
returns text language sql security definer stable as $$
  select role::text from public.profiles where id = auth.uid() limit 1;
$$;

-- requester: see own rows
create policy "requester_select_own" on public.id_requests
  for select using (requester_id = auth.uid());

-- requester: insert (requester_id auto-set by default)
create policy "requester_insert" on public.id_requests
  for insert with check (requester_id = auth.uid());

-- requester: update own pending rows (e.g. edit before approval)
create policy "requester_update_own" on public.id_requests
  for update using (requester_id = auth.uid() and status = 'pending');

-- admin: full access
create policy "admin_all" on public.id_requests
  for all using (public.get_my_role() in ('it_admin', 'sysadmin'))
  with check (public.get_my_role() in ('it_admin', 'sysadmin'));

-- ── Storage buckets ───────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('id-photos',     'id-photos',     true, 5242880, array['image/jpeg','image/png','image/webp']),
  ('id-signatures', 'id-signatures', true, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- storage RLS: owners + admins
create policy "id_photos_insert" on storage.objects
  for insert with check (
    bucket_id = 'id-photos' and auth.uid() is not null
  );
create policy "id_photos_select" on storage.objects
  for select using (bucket_id = 'id-photos');
create policy "id_signatures_insert" on storage.objects
  for insert with check (
    bucket_id = 'id-signatures' and auth.uid() is not null
  );
create policy "id_signatures_select" on storage.objects
  for select using (bucket_id = 'id-signatures');
