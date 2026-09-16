-- ============================================================================
-- Migration 00015: Ticket participants may view each other's profile
-- Fixes: activity-timeline, ticket-details, and dashboard joins to profiles
-- (requester / assignee / actor) returned null for non-admins because RLS only
-- allowed reading your own profile.
--
-- New policy: an authenticated user may SELECT a profile row when that person
-- is the requester OR assignee of a ticket this user is involved in
-- (requester of, assigned to, or admin of). This exposes only ticket
-- participants, not the whole user directory.
-- ============================================================================

begin;

create policy "Users view ticket participants" on public.profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.tickets t
      where (t.requester_id = public.profiles.id or t.assigned_to = public.profiles.id)
        and (
          t.requester_id = auth.uid()
          or t.assigned_to = auth.uid()
          or private.is_admin(auth.uid())
        )
    )
  );

commit;