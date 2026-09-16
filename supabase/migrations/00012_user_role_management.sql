-- ============================================================================
-- Migration 00012: User Role Management hardening
-- Goals:
--   1. Role assignment is System Admin only. it_admin (and self-service
--      updates) may no longer change a user's role through PostgREST.
--   2. Provides a SECURITY DEFINER set_user_role() helper (defense-in-depth)
--      that also protects against demoting the last active System Admin.
-- Edge functions (service_role) remain the primary management path and are
-- unaffected by RLS.
-- ============================================================================

begin;

-- ── 1. Replace the broad "Admin full access to profiles" policy ──────────────
-- Old policy let any it_admin/sysadmin update any column including role.
-- New split keeps it_admin/self updates working for non-role fields but only
-- a System Admin may alter the role column.
drop policy if exists "Admin full access to profiles" on public.profiles;

create policy "Admin manage profiles (except role changes)"
  on public.profiles
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (
    public.is_sysadmin(auth.uid())
    or role is not distinct from public.get_user_role(id)
  );

create policy "SysAdmin full access to profiles"
  on public.profiles
  for all to authenticated
  using (public.is_sysadmin(auth.uid()))
  with check (public.is_sysadmin(auth.uid()));

-- ── 2. SECURITY DEFINER helper: role change entry point ──────────────────────
-- Only a System Admin caller may invoke this. Prevents demoting the last
-- active System Admin.
create or replace function public.set_user_role(uid uuid, new_role public.user_role)
returns public.user_role language plpgsql security definer set search_path = '' as $$
declare
  caller_role public.user_role;
  target_role public.user_role;
begin
  select role into caller_role from public.profiles where id = auth.uid();
  if caller_role <> 'sysadmin' then
    raise exception 'Forbidden: System Admin required';
  end if;

  select role into target_role from public.profiles where id = uid;
  if target_role is null then
    raise exception 'User not found';
  end if;

  if target_role = 'sysadmin' and new_role <> 'sysadmin' then
    if (select count(*) from public.profiles where role = 'sysadmin' and is_active) < 2 then
      raise exception 'Cannot demote the last active System Admin';
    end if;
  end if;

  update public.profiles set role = new_role where id = uid;
  return new_role;
end;
$$;

revoke all on function public.set_user_role(uuid, public.user_role) from public, anon;
grant execute on function public.set_user_role(uuid, public.user_role) to authenticated;

commit;