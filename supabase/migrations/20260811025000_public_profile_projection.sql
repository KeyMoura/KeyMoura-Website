-- Public identity compatibility boundary.
--
-- This migration MUST run before 20260811030000_security_boundary_hardening.sql.
-- The view is intentionally security-definer (the PostgreSQL default for views):
-- callers can read only this fixed projection after RLS closes the base table.

create or replace view public.public_profiles
with (security_barrier = true)
as
select
  id,
  username,
  display_name,
  avatar_url,
  karma,
  is_verified,
  donation_rank
from public.profiles;

comment on view public.public_profiles is
  'Public-safe community identity projection. Never add contact, authorization, moderation, provider, activity, or private metadata columns.';

revoke all on public.public_profiles from public;
grant select on public.public_profiles to anon, authenticated, service_role;

-- Rollback (only before dependent application code is deployed):
--   revoke all on public.public_profiles from anon, authenticated, service_role;
--   drop view public.public_profiles;
