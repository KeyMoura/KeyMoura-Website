-- Blank-project bootstrap: run before opening /install.
-- Do not apply this baseline to an existing database; use timestamped additive migrations.
begin;

create table if not exists public.installation_state (
  singleton boolean primary key default true check (singleton),
  status text not null default 'pending' check (status in ('pending','configuring','complete','failed')),
  attempt_id uuid,
  owner_email text,
  owner_user_id uuid references auth.users(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now()
);
alter table public.installation_state add column if not exists owner_email text;
insert into public.installation_state(singleton) values (true) on conflict do nothing;

create table if not exists public.schema_versions (
  module_key text not null,
  version integer not null check (version > 0),
  checksum text not null,
  applied_at timestamptz not null default now(),
  primary key (module_key, version)
);

create table if not exists public.installed_modules (
  module_key text primary key,
  enabled boolean not null default true,
  schema_version integer not null default 1,
  installed_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists public.site_settings (
  singleton boolean primary key default true check (singleton),
  site_name text not null,
  description text not null default '',
  public_url text not null,
  logo_url text,
  primary_color text not null default '#dc2626',
  accent_color text not null default '#f59e0b',
  terminology jsonb not null default '{}'::jsonb,
  auth_config jsonb not null default '{}'::jsonb,
  registration_closed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.site_settings add column if not exists registration_closed_at timestamptz;

create or replace function public.track_registration_closure()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce((new.auth_config->>'allowSignup')::boolean, true) = false
     and (tg_op = 'INSERT' or coalesce((old.auth_config->>'allowSignup')::boolean, true) = true) then
    new.registration_closed_at := clock_timestamp();
  elsif coalesce((new.auth_config->>'allowSignup')::boolean, true) = true then
    new.registration_closed_at := null;
  end if;
  return new;
end $$;
do $$ begin
  if not exists(select 1 from pg_trigger where tgname='site_settings_track_registration_closure' and not tgisinternal) then
    create trigger site_settings_track_registration_closure before insert or update of auth_config on public.site_settings
    for each row execute function public.track_registration_closure();
  end if;
end $$;

create table if not exists public.roles (
  key text primary key,
  name text not null,
  description text not null default '',
  rank integer not null default 0,
  is_system boolean not null default false
);
create table if not exists public.permissions (
  key text primary key,
  name text not null,
  description text not null default '',
  category text not null default 'general'
);
create table if not exists public.role_permissions (
  role_key text references public.roles(key) on delete cascade,
  permission_key text references public.permissions(key) on delete cascade,
  primary key (role_key, permission_key)
);
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  bio text,
  avatar_url text,
  location text,
  karma integer not null default 0 check (karma >= 0),
  role text not null default 'member',
  is_verified boolean not null default false,
  donation_rank text check (donation_rank is null or donation_rank in ('donor_1','donor_2','donor_3','donor_4','donor_5')),
  is_op boolean not null default false,
  last_ip inet,
  last_user_agent text,
  username_last_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index if not exists profiles_username_lower_idx on public.profiles(lower(username)) where username is not null;
create index if not exists profiles_created_at_idx on public.profiles(created_at desc);
create index if not exists profiles_last_seen_at_idx on public.profiles(last_seen_at desc nulls last);

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null references public.roles(key)
);
create table if not exists public.user_permissions (
  user_id uuid references auth.users(id) on delete cascade,
  permission_key text references public.permissions(key) on delete cascade,
  allowed boolean not null default true,
  primary key (user_id, permission_key)
);

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

-- Blank-project bootstrap primitive. Existing sites must run the additive
-- timestamped migration, which performs authoritative backfill before RLS.
create or replace function public.admit_oauth_account(p_user_id uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare policy_config jsonb; candidate_closed boolean;
begin
  if exists(select 1 from public.account_admissions where user_id=p_user_id) then return 'already_admitted'; end if;
  if exists(select 1 from public.account_admission_review_queue where user_id=p_user_id) then return 'pending_review'; end if;
  select auth_config into policy_config from public.site_settings where singleton=true for update;
  if not found or jsonb_typeof(policy_config->'allowSignup') <> 'boolean' then return 'policy_unavailable'; end if;
  if policy_config->'allowSignup' <> 'true'::jsonb then
    select created_while_registration_closed into candidate_closed from public.account_registration_candidates where user_id=p_user_id;
    if coalesce(candidate_closed,false) then return 'registration_closed'; end if;
    return 'rejected';
  end if;
  insert into public.account_admissions(user_id,admission_source) values(p_user_id,'open_registration')
    on conflict(user_id) do nothing;
  if exists(select 1 from public.account_admissions where user_id=p_user_id) then return 'admitted'; end if;
  return 'rejected';
end $$;
revoke all on function public.admit_oauth_account(uuid) from public,anon,authenticated;
grant execute on function public.admit_oauth_account(uuid) to service_role;

insert into public.roles(key,name,description,rank,is_system) values
 ('member','Member','Community member',10,true),
 ('support','Support','Support staff',40,true),
 ('moderator','Moderator','Moderation staff',60,true),
 ('admin','Administrator','Site owner and administrator',100,true)
on conflict (key) do nothing;
insert into public.permissions(key,name,description,category) values
 ('admin.access','Administration access','Access administration tools','security'),
 ('roles.manage','Manage roles','Manage roles and permissions','security'),
 ('users.manage','Manage users','Manage user accounts','security')
on conflict (key) do nothing;
insert into public.role_permissions(role_key,permission_key)
select 'admin', key from public.permissions on conflict do nothing;

alter table public.installation_state enable row level security;
alter table public.schema_versions enable row level security;
alter table public.installed_modules enable row level security;
alter table public.site_settings enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.user_permissions enable row level security;
alter table public.account_admissions enable row level security;
alter table public.account_admission_review_queue enable row level security;
alter table public.account_registration_candidates enable row level security;

revoke all on public.installation_state, public.schema_versions from anon, authenticated;
revoke all on public.account_admissions from public, anon, authenticated;
revoke all on public.account_admission_review_queue from public, anon, authenticated;
revoke all on public.account_registration_candidates from public, anon, authenticated;
revoke all on public.site_settings, public.installed_modules from anon, authenticated;
grant select on public.site_settings, public.installed_modules, public.roles, public.permissions to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update(display_name,bio,location,avatar_url) on public.profiles to authenticated;

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

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles readable') then create policy "profiles readable" on public.profiles for select to anon, authenticated using (true); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='own profile update') then create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='roles' and policyname='public roles readable') then create policy "public roles readable" on public.roles for select to anon, authenticated using (true); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='permissions' and policyname='public permissions readable') then create policy "public permissions readable" on public.permissions for select to anon, authenticated using (true); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='site_settings' and policyname='settings readable') then create policy "settings readable" on public.site_settings for select to anon, authenticated using (true); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='installed_modules' and policyname='modules readable') then create policy "modules readable" on public.installed_modules for select to anon, authenticated using (true); end if;
end $$;

do $$ declare t record;
begin
  for t in select tablename from pg_tables where schemaname='public'
    and rowsecurity and tablename not in ('account_admissions','account_admission_review_queue','account_registration_candidates')
    and not exists(select 1 from pg_policies p where p.schemaname='public'
      and p.tablename=pg_tables.tablename and p.policyname='account_admission_required') loop
    execute format('create policy account_admission_required on public.%I as restrictive for all to authenticated using (public.is_account_admitted()) with check (public.is_account_admitted())',t.tablename);
  end loop;
end $$;

create or replace function public.touch_last_seen()
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare touched_at timestamptz;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501'; end if;
  if not public.is_account_admitted() then raise exception 'ACCOUNT_ADMISSION_REQUIRED' using errcode = '42501'; end if;
  update public.profiles
  set last_seen_at = clock_timestamp()
  where id = auth.uid()
    and (last_seen_at is null or last_seen_at <= clock_timestamp() - interval '5 minutes')
  returning last_seen_at into touched_at;
  return touched_at;
end $$;
revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

create or replace function public.complete_first_install(
  p_attempt_id uuid, p_owner_user_id uuid, p_username text,
  p_settings jsonb, p_modules text[]
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare current_state public.installation_state%rowtype; module_name text;
begin
  perform pg_advisory_xact_lock(hashtext('schassis:first-install'));
  select * into current_state from public.installation_state where singleton for update;
  if current_state.status = 'complete' then
    if current_state.owner_user_id = p_owner_user_id then return jsonb_build_object('status','complete','resumed',true); end if;
    raise exception 'INSTALLATION_LOCKED' using errcode = '42501';
  end if;
  if current_state.status <> 'configuring' or current_state.attempt_id is distinct from p_attempt_id then
    raise exception 'INSTALLATION_ATTEMPT_MISMATCH' using errcode = '42501';
  end if;
  if current_state.owner_email is distinct from (select lower(email) from auth.users where id=p_owner_user_id)
     or not exists (select 1 from auth.users where id=p_owner_user_id
       and raw_app_meta_data->>'installer_attempt_id'=p_attempt_id::text
       and raw_app_meta_data->>'installer_owner_email'=current_state.owner_email) then
    raise exception 'OWNER_CONTROL_NOT_PROVEN' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(p_modules) requested(module_key)
    where not exists (select 1 from public.schema_versions sv where sv.module_key=requested.module_key and sv.version >= 1)) then
    raise exception 'MODULE_SCHEMA_UNAVAILABLE' using errcode = '22023';
  end if;
  update public.installation_state set status='configuring', attempt_id=p_attempt_id,
    started_at=coalesce(started_at,now()), last_error_code=null, updated_at=now() where singleton;
  insert into public.profiles(id,username,display_name) values(p_owner_user_id,p_username,p_username)
    on conflict(id) do update set username=excluded.username, display_name=coalesce(public.profiles.display_name,excluded.display_name);
  insert into public.user_roles(user_id,role) values(p_owner_user_id,'admin')
    on conflict(user_id) do update set role='admin';
  insert into public.account_admissions(user_id,admission_source) values(p_owner_user_id,'installer_owner')
    on conflict(user_id) do nothing;
  insert into public.site_settings(singleton,site_name,description,public_url,logo_url,primary_color,accent_color,terminology,auth_config)
    values(true,p_settings->>'site_name',coalesce(p_settings->>'description',''),p_settings->>'public_url',
      nullif(p_settings->>'logo_url',''),coalesce(p_settings->>'primary_color','#dc2626'),
      coalesce(p_settings->>'accent_color','#f59e0b'),coalesce(p_settings->'terminology','{}'),coalesce(p_settings->'auth_config','{}'))
    on conflict(singleton) do update set site_name=excluded.site_name,description=excluded.description,public_url=excluded.public_url,
      logo_url=excluded.logo_url,primary_color=excluded.primary_color,accent_color=excluded.accent_color,
      terminology=excluded.terminology,auth_config=excluded.auth_config,updated_at=now();
  insert into public.installed_modules(module_key,enabled,schema_version) values('core',true,1)
    on conflict(module_key) do update set enabled=true,disabled_at=null;
  foreach module_name in array p_modules loop
    insert into public.installed_modules(module_key,enabled,schema_version) values(module_name,true,1)
      on conflict(module_key) do update set enabled=true,disabled_at=null;
  end loop;
  insert into public.schema_versions(module_key,version,checksum) values('core',1,'installer-core-v1') on conflict do nothing;
  update public.installation_state set status='complete',owner_user_id=p_owner_user_id,completed_at=now(),updated_at=now() where singleton;
  return jsonb_build_object('status','complete','resumed',false);
end $$;
revoke all on function public.complete_first_install(uuid,uuid,text,jsonb,text[]) from public,anon,authenticated;
grant execute on function public.complete_first_install(uuid,uuid,text,jsonb,text[]) to service_role;

create or replace function public.claim_first_install(p_attempt_id uuid, p_owner_email text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare current_state public.installation_state%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('schassis:first-install'));
  select * into current_state from public.installation_state where singleton for update;
  if current_state.status = 'complete' then raise exception 'INSTALLATION_LOCKED' using errcode='42501'; end if;
  if current_state.status = 'configuring' and
     (current_state.owner_email is distinct from lower(p_owner_email) or current_state.attempt_id is distinct from p_attempt_id) then
    raise exception 'INSTALLATION_IN_PROGRESS' using errcode='55P03';
  end if;
  update public.installation_state set status='configuring', attempt_id=p_attempt_id,
    owner_email=lower(p_owner_email), started_at=coalesce(started_at,now()), updated_at=now() where singleton;
  return 'claimed';
end $$;
revoke all on function public.claim_first_install(uuid,text) from public,anon,authenticated;
grant execute on function public.claim_first_install(uuid,text) to service_role;

insert into public.schema_versions(module_key,version,checksum) values('core',1,'installer-core-v2') on conflict do nothing;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('avatars','avatars',true,5242880,array['image/jpeg','image/png','image/webp','image/gif']) on conflict(id) do nothing;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='avatar owner upload') then
    create policy "avatar owner upload" on storage.objects for insert to authenticated
      with check(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
  end if;
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='avatar owner update') then
    create policy "avatar owner update" on storage.objects for update to authenticated
      using(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text)
      with check(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
  end if;
end $$;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='account admission required') then
    create policy "account admission required" on storage.objects as restrictive for all to authenticated
      using(public.is_account_admitted()) with check(public.is_account_admitted());
  end if;
end $$;

commit;
