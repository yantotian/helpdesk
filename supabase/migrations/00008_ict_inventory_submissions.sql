
-- Requester inventory submission requests
create table if not exists public.ict_inventory_submissions (
  id uuid primary key default gen_random_uuid(),
  submission_type text not null check (submission_type in ('device','internet')),
  -- common
  submitted_by uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  -- device fields
  device_type text,
  brand text,
  model text,
  serial_no text,
  asset_tag text,
  location text,
  assigned_to text,
  cpu text,
  gpu text,
  ram_gb integer,
  storage_gb integer,
  storage_type text,
  os text,
  printer_type text,
  is_network_printer boolean,
  router_type text,
  wifi_standard text,
  num_ports integer,
  purchase_date date,
  warranty_until date,
  -- internet fields
  isp_name text,
  plan_name text,
  plan_type text,
  subscribed_speed_mbps numeric,
  monthly_cost numeric,
  contract_start date,
  contract_end date,
  account_no text,
  contact_person text,
  contact_number text,
  -- shared
  notes text
);

alter table public.ict_inventory_submissions enable row level security;

-- Requesters: insert own, read own
create policy "requester_insert_own_submissions"
  on public.ict_inventory_submissions for insert
  to authenticated
  with check (submitted_by = auth.uid());

create policy "requester_read_own_submissions"
  on public.ict_inventory_submissions for select
  to authenticated
  using (submitted_by = auth.uid());

-- Admins: full access
create policy "admin_all_submissions"
  on public.ict_inventory_submissions for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('it_admin','sysadmin','technician')
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where id = auth.uid()
        and role in ('it_admin','sysadmin','technician')
    )
  );
