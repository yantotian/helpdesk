
-- ICT Devices: Laptops, Desktops, Printers, Routers
create table public.ict_devices (
  id          uuid primary key default gen_random_uuid(),
  device_type text not null check (device_type in ('laptop','desktop','printer','router')),
  brand       text not null,
  model       text not null,
  serial_no   text,
  asset_tag   text,
  location    text,
  assigned_to text,
  status      text not null default 'active' check (status in ('active','inactive','under_repair','retired')),
  -- compute specs (laptops/desktops)
  cpu         text,
  gpu         text,
  ram_gb      integer,
  storage_gb  integer,
  storage_type text check (storage_type in ('HDD','SSD','NVMe','eMMC') or storage_type is null),
  os          text,
  -- printer specs
  printer_type text check (printer_type in ('inkjet','laser','dot_matrix','thermal') or printer_type is null),
  is_network_printer boolean default false,
  -- router specs
  router_type  text check (router_type in ('wired','wireless','fiber','mesh') or router_type is null),
  wifi_standard text,
  num_ports    integer,
  -- shared
  purchase_date date,
  warranty_until date,
  notes        text,
  created_by   uuid not null default auth.uid() references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ISP / Internet connections
create table public.ict_internet (
  id              uuid primary key default gen_random_uuid(),
  location        text not null,
  isp_name        text not null,
  plan_name       text not null,
  plan_type       text not null check (plan_type in ('fiber','dsl','cable','wireless','satellite')),
  subscribed_speed_mbps integer not null,
  actual_dl_mbps  numeric(6,2),
  actual_ul_mbps  numeric(6,2),
  monthly_cost    numeric(10,2),
  contract_start  date,
  contract_end    date,
  account_no      text,
  contact_person  text,
  contact_number  text,
  router_id       uuid references public.ict_devices(id) on delete set null,
  status          text not null default 'active' check (status in ('active','inactive','suspended')),
  notes           text,
  created_by      uuid not null default auth.uid() references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Updated_at triggers
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger ict_devices_updated_at before update on public.ict_devices
  for each row execute function public.set_updated_at();
create trigger ict_internet_updated_at before update on public.ict_internet
  for each row execute function public.set_updated_at();

-- RLS
alter table public.ict_devices enable row level security;
alter table public.ict_internet enable row level security;

-- All authenticated users can view
create policy "ict_devices_select" on public.ict_devices for select to authenticated using (true);
create policy "ict_internet_select" on public.ict_internet for select to authenticated using (true);

-- Only it_admin / sysadmin can insert/update/delete
-- We use a helper to check profile role
create or replace function public.is_ict_admin()
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('it_admin','sysadmin')
  );
$$;

create policy "ict_devices_insert" on public.ict_devices for insert to authenticated
  with check (public.is_ict_admin());
create policy "ict_devices_update" on public.ict_devices for update to authenticated
  using (public.is_ict_admin()) with check (public.is_ict_admin());
create policy "ict_devices_delete" on public.ict_devices for delete to authenticated
  using (public.is_ict_admin());

create policy "ict_internet_insert" on public.ict_internet for insert to authenticated
  with check (public.is_ict_admin());
create policy "ict_internet_update" on public.ict_internet for update to authenticated
  using (public.is_ict_admin()) with check (public.is_ict_admin());
create policy "ict_internet_delete" on public.ict_internet for delete to authenticated
  using (public.is_ict_admin());

-- Indexes
create index ict_devices_type_idx on public.ict_devices(device_type);
create index ict_devices_status_idx on public.ict_devices(status);
create index ict_internet_status_idx on public.ict_internet(status);
