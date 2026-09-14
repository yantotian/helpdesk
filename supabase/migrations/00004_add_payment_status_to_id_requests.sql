
alter table public.id_requests
  add column if not exists is_paid boolean not null default false;
