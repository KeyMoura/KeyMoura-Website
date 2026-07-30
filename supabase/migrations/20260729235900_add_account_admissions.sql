-- Durable admission replaces auth-user creation timestamps as account policy.
-- Existing roles and installer ownership are authoritative legacy membership.
begin;

create table if not exists public.account_admissions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  admitted_at timestamptz not null default now(),
  admitted_by uuid references auth.users(id) on delete set null,
  admission_source text not null check (admission_source in ('legacy_membership','installer_owner','administrator','open_registration','operator_allowlist'))
);
create table if not exists public.account_admission_review_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  reason text not null,
  discovered_at timestamptz not null default now()
);
create table if not exists public.account_registration_candidates (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_while_registration_closed boolean not null,
  observed_at timestamptz not null default now()
);

alter table public.account_admissions enable row level security;
alter table public.account_admission_review_queue enable row level security;
alter table public.account_registration_candidates enable row level security;
revoke all on public.account_admissions from public, anon, authenticated;
revoke all on public.account_admission_review_queue from public, anon, authenticated;
revoke all on public.account_registration_candidates from public, anon, authenticated;

-- A role assignment is the legacy application's authoritative membership grant.
insert into public.account_admissions(user_id,admission_source)
select distinct user_id,'legacy_membership' from public.user_roles
where exists(select 1 from auth.users u where u.id=user_id)
on conflict(user_id) do nothing;
insert into public.account_admissions(user_id,admission_source)
select owner_user_id,'installer_owner' from public.installation_state
where singleton and status='complete' and owner_user_id is not null
on conflict(user_id) do nothing;

-- Do not infer membership for remaining identities; expose a service-only review queue.
insert into public.account_admission_review_queue(user_id,email,reason)
select u.id,u.email,'No authoritative legacy membership record'
from auth.users u left join public.account_admissions a on a.user_id=u.id
where a.user_id is null on conflict(user_id) do nothing;

-- Only identities inserted after this migration can be proven newly created.
create or replace function public.record_account_registration_candidate()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare policy_value jsonb;
begin
  select auth_config->'allowSignup' into policy_value from public.site_settings where singleton;
  insert into public.account_registration_candidates(user_id,created_while_registration_closed)
  values(new.id, coalesce(policy_value = 'false'::jsonb,false)) on conflict(user_id) do nothing;
  return new;
end $$;
revoke all on function public.record_account_registration_candidate() from public, anon, authenticated;
do $$ begin
  if not exists(select 1 from pg_trigger where tgname='auth_user_registration_candidate' and not tgisinternal) then
    create trigger auth_user_registration_candidate after insert on auth.users
      for each row execute function public.record_account_registration_candidate();
  end if;
end $$;

-- Atomically decide OAuth admission under the authoritative policy-row lock.
-- This is intentionally not executable by browser roles.
create or replace function public.admit_oauth_account(p_user_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  policy_config jsonb;
  candidate_closed boolean;
begin
  if exists(select 1 from public.account_admissions where user_id=p_user_id) then
    return 'already_admitted';
  end if;
  if exists(select 1 from public.account_admission_review_queue where user_id=p_user_id) then
    return 'pending_review';
  end if;

  select auth_config into policy_config
  from public.site_settings where singleton=true for update;
  if not found or jsonb_typeof(policy_config->'allowSignup') <> 'boolean' then
    return 'policy_unavailable';
  end if;
  if policy_config->'allowSignup' <> 'true'::jsonb then
    select created_while_registration_closed into candidate_closed
    from public.account_registration_candidates where user_id=p_user_id;
    if coalesce(candidate_closed,false) then return 'registration_closed'; end if;
    return 'rejected';
  end if;

  insert into public.account_admissions(user_id,admission_source)
  values(p_user_id,'open_registration') on conflict(user_id) do nothing;
  if exists(select 1 from public.account_admissions where user_id=p_user_id) then
    return 'admitted';
  end if;
  return 'rejected';
end $$;
revoke all on function public.admit_oauth_account(uuid) from public, anon, authenticated;
grant execute on function public.admit_oauth_account(uuid) to service_role;

-- Revoke the obsolete cross-user signature before exposing the caller-bound check.
do $$ begin
  if to_regprocedure('public.is_account_admitted(uuid)') is not null then
    execute 'revoke all on function public.is_account_admitted(uuid) from public, anon, authenticated, service_role';
  end if;
end $$;
create or replace function public.is_account_admitted()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and exists(select 1 from public.account_admissions where user_id=auth.uid())
$$;
revoke all on function public.is_account_admitted() from public, anon;
grant execute on function public.is_account_admitted() to authenticated;

-- Restrictive policies compose with every existing RLS policy and prevent JWT users
-- from accessing application tables until service-side admission has occurred.
do $$ declare t record;
begin
  for t in select tablename from pg_tables where schemaname='public'
    and rowsecurity and tablename not in ('account_admissions','account_admission_review_queue','account_registration_candidates')
    and not exists(select 1 from pg_policies p where p.schemaname='public'
      and p.tablename=pg_tables.tablename and p.policyname='account_admission_required') loop
    execute format('create policy account_admission_required on public.%I as restrictive for all to authenticated using (public.is_account_admitted()) with check (public.is_account_admitted())',t.tablename);
  end loop;
end $$;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='account admission required') then
    create policy "account admission required" on storage.objects as restrictive for all to authenticated
      using(public.is_account_admitted()) with check(public.is_account_admitted());
  end if;
end $$;

-- Recreate the only browser-executable SECURITY DEFINER RPC with an admission guard.
create or replace function public.touch_last_seen()
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare touched_at timestamptz;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_account_admitted() then raise exception 'ACCOUNT_ADMISSION_REQUIRED' using errcode = '42501'; end if;
  update public.profiles set last_seen_at=clock_timestamp()
  where id=auth.uid() and (last_seen_at is null or last_seen_at <= clock_timestamp()-interval '5 minutes')
  returning last_seen_at into touched_at;
  return touched_at;
end $$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

commit;
