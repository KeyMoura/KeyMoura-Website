-- Close identity and authorization base tables. Public identity reads belong on
-- public.public_profiles, created by 20260811025000.

revoke select on public.profiles from anon;
revoke select on public.roles, public.permissions from anon, authenticated;

drop policy if exists "profiles readable" on public.profiles;
drop policy if exists "public roles readable" on public.roles;
drop policy if exists "public permissions readable" on public.permissions;

create policy "profiles own or staff read" on public.profiles
for select to authenticated
using (id = (select auth.uid()) or (select public.is_staff_user()));

create policy "staff read roles" on public.roles
for select to authenticated
using ((select public.is_staff_user()));

create policy "staff read permissions" on public.permissions
for select to authenticated
using ((select public.is_staff_user()));

-- TRUNCATE is not governed by RLS. No application runtime, including the
-- service role, needs it on these identity/authorization relations.
revoke truncate on public.profiles, public.roles, public.permissions,
  public.role_permissions, public.user_roles, public.user_permissions
from service_role;

-- Rollback (emergency only; restores the former broad read boundary):
--   drop policy if exists "profiles own or staff read" on public.profiles;
--   drop policy if exists "staff read roles" on public.roles;
--   drop policy if exists "staff read permissions" on public.permissions;
--   grant select on public.profiles, public.roles, public.permissions to anon, authenticated;
--   create policy "profiles readable" on public.profiles for select to anon, authenticated using (true);
--   create policy "public roles readable" on public.roles for select to anon, authenticated using (true);
--   create policy "public permissions readable" on public.permissions for select to anon, authenticated using (true);
