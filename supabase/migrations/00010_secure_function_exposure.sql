-- ============================================================================
-- Migration 00010: Harden SECURITY DEFINER function exposure
-- Fixes:
--   1. Moves app SECURITY DEFINER helpers out of the PostgREST-exposed `public`
--      schema into a dedicated `private` schema (clears
--      anon_/authenticated_security_definer_function_executable lints).
--   2. Revokes blanket EXECUTE on the moved functions from anon/authenticated
--      where it is not required (policies/triggers resolve by OID, so the
--      schema move keeps every existing policy, trigger, and event trigger
--      working).
--   3. Revokes EXECUTE on the platform-managed rls_auto_enable() helper.
--   4. Moves the pg_net extension namespace out of `public`
--      (clears extension_in_public lint). All pg_net objects already live in
--      the `net` schema; only the extension's namespace updates.
--   5. Tightens default privileges so future functions are opt-in.
-- ============================================================================

begin;

-- ── 1. Private schema for app helper functions ───────────────────────────────
create schema if not exists private;

-- Schema USAGE is required so that SET-search_path / qualified references in
-- migrated policy node trees can still find the functions by OID if needed.
-- `authenticated` and `service_role` get USAGE; anon does not (it never uses
-- these helpers). postgres (owner) always has USAGE implicitly.
grant usage on schema private to authenticated;
grant usage on schema private to service_role;

-- ── 2. Move app helpers out of `public` ─────────────────────────────────────
-- Postgres stores function references inside policies/triggers/event triggers
-- as OIDs, so moving the function to another schema does not break them.
alter function public.get_my_role() set schema private;
alter function public.get_user_role(uid uuid) set schema private;
alter function public.is_admin(uid uuid) set schema private;
alter function public.is_sysadmin(uid uuid) set schema private;
alter function public.is_ict_admin() set schema private;
alter function public.ticket_requester(ticket_id uuid) set schema private;
alter function public.ticket_assigned_to(ticket_id uuid) set schema private;
alter function public.handle_new_user() set schema private;
alter function public.touch_id_request() set schema private;

-- ── 3. Tighten EXECUTE on the moved helpers ────────────────────────────────
-- RLS policy expressions that call these helpers execute with the querying
-- role's privileges, so `authenticated` MUST retain EXECUTE on the 7 helpers
-- referenced by RLS/storage policies. anon is dropped everywhere.
revoke execute on function private.get_my_role() from public, anon;
revoke execute on function private.get_user_role(uid uuid) from public, anon;
revoke execute on function private.is_admin(uid uuid) from public, anon;
revoke execute on function private.is_sysadmin(uid uuid) from public, anon;
revoke execute on function private.is_ict_admin() from public, anon;
revoke execute on function private.ticket_requester(ticket_id uuid) from public, anon;
revoke execute on function private.ticket_assigned_to(ticket_id uuid) from public, anon;

-- Trigger-only helpers: Postgres checks EXECUTE only when the trigger is
-- CREATE'd (never at fire time), so dropping them from anon/authenticated is
-- safe and removes the RPC surface entirely.
revoke execute on function private.handle_new_user() from public, anon, authenticated;
revoke execute on function private.touch_id_request() from public, anon, authenticated;

-- Explicitly re-grant what must remain callable (idempotent, documents intent).
grant execute on function private.get_my_role() to authenticated, service_role;
grant execute on function private.get_user_role(uid uuid) to authenticated, service_role;
grant execute on function private.is_admin(uid uuid) to authenticated, service_role;
grant execute on function private.is_sysadmin(uid uuid) to authenticated, service_role;
grant execute on function private.is_ict_admin() to authenticated, service_role;
grant execute on function private.ticket_requester(ticket_id uuid) to authenticated, service_role;
grant execute on function private.ticket_assigned_to(ticket_id uuid) to authenticated, service_role;

-- Keep trigger helpers available to platform/edge flows that may still load
-- them, but never via public/anon/authenticated.
grant execute on function private.handle_new_user() to service_role;
grant execute on function private.touch_id_request() to service_role;

-- ── 4. Platform-managed rls_auto_enable() ──────────────────────────────────
-- Used only by the Supabase platform `ensure_rls` event trigger; event
-- triggers check EXECUTE at creation time, so revoking from end-user roles is
-- safe and stops direct RPC invocation.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- ── 5. pg_net NOTE ─────────────────────────────────────────────────────────
-- pg_net cannot be relocated: its extnamespace is `public` but all of its
-- member objects live in the `net` schema, and the extension is marked
-- non-relocatable. ALTER EXTENSION ... SET SCHEMA is therefore rejected by
-- Postgres (0A000), even when temporarily flipping extrelocatable, because the
-- member schemas do not all match the extension's namespace. Its callable
-- surface (net.http_get/http_post/http_collect_response + queue tables) is
-- entirely inside `net`, so the `extension_in_public` WARN is a registration
-- artifact with no exposed objects in `public`. Left as the single accepted
-- exception for this project (matches Supabase's guidance for managed pg_net).

-- ── 6. Default privileges: future functions are opt-in ──────────────────────
-- Stop Supabase's built-in default (grants EXECUTE to PUBLIC on new functions)
-- from auto-exposing future functions. Existing functions are unaffected.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;

commit;