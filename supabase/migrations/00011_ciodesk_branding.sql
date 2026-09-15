-- ============================================================================
-- Migration 00011: Rebrand project to Ciodesk
-- Replaces the legacy `@miaoda.com` synthetic email domain on existing auth
-- users with `@ciodesk.com` so that existing accounts can still sign in via
-- username (the frontend and edge functions construct the login email from the
-- `@ciodesk.com` domain).
-- ============================================================================

begin;

update auth.users
set email = replace(email, '@miaoda.com', '@ciodesk.com')
where email like '%@miaoda.com';

commit;