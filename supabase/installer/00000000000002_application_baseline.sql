-- Complete additive application baseline reconstructed from the current app.
-- Safe to run on an existing KeyMoura installation. No tables or rows are dropped.
begin;

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Garage is a first-party public module and must be present in the standalone
-- application baseline, not only in the optional installer module directory.
create table if not exists public.garage_cars (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text,
  make text not null check (length(trim(make)) > 0),
  model text not null check (length(trim(model)) > 0),
  year integer check (year between 1900 and 2100),
  chassis text,
  trim text,
  color text,
  engine text,
  power_hp integer check (power_hp is null or power_hp >= 0),
  torque_ftlb integer check (torque_ftlb is null or torque_ftlb >= 0),
  weight_lb integer check (weight_lb is null or weight_lb > 0),
  use_type text not null default 'street',
  visibility text not null default 'public' check (visibility in ('public','unlisted','private')),
  is_primary boolean not null default false,
  summary text,
  mods text,
  cover_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists garage_one_primary_per_owner on public.garage_cars(owner_id) where is_primary;
create index if not exists garage_public_order_idx on public.garage_cars(visibility,is_primary desc,created_at desc);
create index if not exists garage_owner_idx on public.garage_cars(owner_id,updated_at desc);

create table if not exists public.garage_car_likes (
  car_id uuid references public.garage_cars(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(car_id,user_id)
);
create index if not exists garage_likes_user_idx on public.garage_car_likes(user_id,created_at desc);
alter table public.garage_cars enable row level security;
alter table public.garage_car_likes enable row level security;

do $$
begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage visible read') then create policy "garage visible read" on public.garage_cars for select to anon,authenticated using(visibility='public' or owner_id=auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner insert') then create policy "garage owner insert" on public.garage_cars for insert to authenticated with check(owner_id=auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner update') then create policy "garage owner update" on public.garage_cars for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner delete') then create policy "garage owner delete" on public.garage_cars for delete to authenticated using(owner_id=auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='garage likes read') then create policy "garage likes read" on public.garage_car_likes for select to anon,authenticated using(true); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='garage likes own') then create policy "garage likes own" on public.garage_car_likes for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='account_admission_required') then create policy account_admission_required on public.garage_cars as restrictive for all to authenticated using(public.is_account_admitted()) with check(public.is_account_admitted()); end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='account_admission_required') then create policy account_admission_required on public.garage_car_likes as restrictive for all to authenticated using(public.is_account_admitted()) with check(public.is_account_admitted()); end if;
end
$$;

grant select on public.garage_cars,public.garage_car_likes to anon,authenticated;
grant insert,update,delete on public.garage_cars,public.garage_car_likes to authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('garage-covers','garage-covers',true,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
do $$
begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='garage covers owner upload') then
    create policy "garage covers owner upload" on storage.objects for insert to authenticated
    with check(bucket_id='garage-covers' and (storage.foldername(name))[1]=auth.uid()::text);
  end if;
end
$$;

alter table public.roles add column if not exists is_staff boolean not null default false;
alter table public.roles add column if not exists badge_bg text;
alter table public.roles add column if not exists badge_border text;
alter table public.roles add column if not exists badge_text text;
update public.roles set is_staff = key in ('admin', 'moderator', 'support');

insert into public.permissions(key, name, description, category)
select permission_key, initcap(replace(permission_key, '.', ' ')), '', split_part(permission_key, '.', 1)
from unnest(array[
  'analytics.view','community.view','security.view','audit.view','shops.view',
  'moderation.reports.view','moderation.reports.moderate','moderation.reports.override',
  'moderation.ban','moderation.ban.request','moderation.restrict','moderation.restrict.request',
  'moderation.timeout','moderation.timeout.request','moderation.timeout.community',
  'moderation.timeout.community.request','moderation.timeout.dm','moderation.timeout.dm.request',
  'moderation.restrict.community','moderation.restrict.community.request','moderation.restrict.dm',
  'moderation.restrict.dm.request','community.create_thread','community.lock_thread',
  'community.thread.lock.own','community.pin_thread','community.delete_post','community.post.edit',
  'community.post.edit.own','community.post.delete.own','community.restore_post',
  'community.mark_answer','community.thread.mark_answer.own','community.flags.set.1',
  'community.flags.set.3','community.flags.set.5','community.flags.set.10',
  'community.categories.manage','community.categories.edit','community.delete_thread',
  'community.thread.delete.own','community.blocks.bypass','notifications.broadcast',
  'info.submit','info.update.submit','info.moderate','info.pending.view','info.updates.view',
  'todo.view','todo.create_task','todo.mark_done','todo.edit','shops.moderate','shops.create',
  'shops.modify','shops.delete','shops.publish','shops.reorder','audit.read','users.dm',
  'users.view','recycle_bin.view','recycle_bin.restore','roles.view',
  'security.verified_perks.manage','recycle_bin.read','roles.manage','permissions.manage',
  'roles.assign','permissions.grant','users.search','users.verify','users.donation_rank.set',
  'users.profile.edit','security.approvals.manage','security.approvals.override','users.create',
  'security.force_logout','security.settings.manage','security.broadcast','security.ip_logs.view'
]::text[]) permission_key
on conflict (key) do nothing;
insert into public.role_permissions(role_key, permission_key)
select 'admin', key from public.permissions on conflict do nothing;

create or replace function public.is_staff_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role in ('admin', 'moderator', 'support')
  )
$$;
revoke all on function public.is_staff_user() from public, anon;
grant execute on function public.is_staff_user() to authenticated;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  actor_ip inet,
  event_type text not null,
  target_table text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index if not exists audit_logs_actor_idx on public.audit_logs(actor_user_id, created_at desc);

create table if not exists public.auth_login_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references auth.users(id) on delete set null,
  event_type text not null default 'session',
  email text,
  provider text,
  success boolean not null default true,
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists auth_login_events_user_idx on public.auth_login_events(profile_id, created_at desc);

create table if not exists public.user_blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks(blocked_user_id);

create table if not exists public.user_restrictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('site', 'community', 'dm')),
  active boolean not null default true,
  reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists user_restrictions_active_idx on public.user_restrictions(user_id, kind) where active;

create table if not exists public.site_verified_perks (
  id bigint primary key default 1 check (id = 1),
  permissions text[] not null default '{}',
  updated_at timestamptz not null default now()
);
insert into public.site_verified_perks(id) values (1) on conflict do nothing;

create table if not exists public.admin_action_requests (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null references auth.users(id) on delete cascade,
  requested_ip inet,
  target_user_id uuid references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists admin_action_requests_status_idx on public.admin_action_requests(status, requested_at desc);

alter table public.site_security_settings add column if not exists admin_override_password text;

create or replace function public.hash_lockdown_password()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
begin
  if new.lockdown_password is not null
     and new.lockdown_password <> ''
     and new.lockdown_password !~ '^\$2[aby]\$' then
    new.lockdown_password := extensions.crypt(new.lockdown_password, extensions.gen_salt('bf'));
  end if;
  if new.admin_override_password is not null
     and new.admin_override_password <> ''
     and new.admin_override_password !~ '^\$2[aby]\$' then
    new.admin_override_password := extensions.crypt(new.admin_override_password, extensions.gen_salt('bf'));
  end if;
  return new;
end
$$;
do $$ begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'site_security_settings_hash_password' and not tgisinternal
  ) then
    create trigger site_security_settings_hash_password
    before insert or update of lockdown_password, admin_override_password on public.site_security_settings
    for each row execute function public.hash_lockdown_password();
  end if;
end $$;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  type text not null,
  thread_id bigint,
  post_id bigint,
  payload jsonb,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.notifications add column if not exists read_at timestamptz;
create index if not exists notifications_user_idx on public.notifications(user_id, is_read, created_at desc);

create table if not exists public.forum_categories (
  id bigint generated by default as identity primary key,
  slug text not null,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_archived boolean not null default false,
  parent_id bigint references public.forum_categories(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(slug)
);
create index if not exists forum_categories_parent_id_idx on public.forum_categories(parent_id);
create index if not exists forum_categories_order_idx on public.forum_categories(sort_order, created_at);

create table if not exists public.forum_threads (
  id bigint generated by default as identity primary key,
  category_id bigint not null references public.forum_categories(id) on delete cascade,
  title text not null,
  slug text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete cascade,
  tags text[] not null default '{}',
  is_pinned boolean not null default false,
  is_locked boolean not null default false,
  is_deleted boolean not null default false,
  accepted_post_id bigint,
  view_count bigint not null default 0,
  reply_count integer not null default 0,
  last_post_at timestamptz,
  last_post_by uuid references auth.users(id) on delete set null,
  locked_by uuid references auth.users(id) on delete set null,
  locked_at timestamptz,
  locked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(category_id, slug)
);
update public.forum_threads set author_user_id = created_by where author_user_id is null;
create index if not exists forum_threads_category_idx on public.forum_threads(category_id, is_pinned desc, last_post_at desc);
create index if not exists forum_threads_author_idx on public.forum_threads(author_user_id, created_at desc);

create table if not exists public.forum_posts (
  id bigint generated by default as identity primary key,
  thread_id bigint not null references public.forum_threads(id) on delete cascade,
  parent_post_id bigint references public.forum_posts(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  body_markdown text not null,
  is_deleted boolean not null default false,
  edit_reason text,
  vote_score integer not null default 0,
  upvote_count integer not null default 0,
  downvote_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists forum_posts_thread_idx on public.forum_posts(thread_id, created_at);
create index if not exists forum_posts_author_idx on public.forum_posts(created_by, created_at desc);
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'forum_threads_accepted_post_id_fkey'
      and conrelid = 'public.forum_threads'::regclass
  ) then
    alter table public.forum_threads
      add constraint forum_threads_accepted_post_id_fkey
      foreign key (accepted_post_id) references public.forum_posts(id) on delete set null;
  end if;
end $$;

create table if not exists public.forum_post_votes (
  post_id bigint not null references public.forum_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key(post_id, user_id)
);

create table if not exists public.forum_flags (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('thread', 'post')),
  target_id bigint not null,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null
);
create index if not exists forum_flags_status_idx on public.forum_flags(status, created_at desc);

create table if not exists public.forum_moderators (
  category_id bigint not null references public.forum_categories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(category_id, user_id)
);

create table if not exists public.forum_thread_lead_scores (
  thread_id bigint primary key references public.forum_threads(id) on delete cascade,
  lead_vote_score integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.info_pages (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  content_markdown text not null default '',
  category text,
  chassis text,
  tags text[] not null default '{}',
  status text not null default 'pending' check (status in ('draft', 'pending', 'approved', 'published', 'rejected', 'archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists info_pages_status_idx on public.info_pages(status, updated_at desc);
create index if not exists info_pages_tags_idx on public.info_pages using gin(tags);
create index if not exists info_pages_search_idx on public.info_pages using gin (
  (coalesce(title, '') || ' ' || coalesce(content_markdown, '')) extensions.gin_trgm_ops
);

create table if not exists public.info_page_drafts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null,
  content_markdown text not null default '',
  category text,
  chassis text,
  tags text[] not null default '{}',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists info_page_drafts_owner_idx on public.info_page_drafts(created_by, updated_at desc);

create table if not exists public.info_page_updates (
  id uuid primary key default gen_random_uuid(),
  info_page_id uuid not null references public.info_pages(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  original_title text,
  original_content_markdown text,
  original_tags text[],
  original_category text,
  original_chassis text,
  proposed_title text,
  proposed_content_markdown text not null,
  proposed_tags text[],
  proposed_category text,
  proposed_chassis text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists info_page_updates_status_idx on public.info_page_updates(status, created_at);

create table if not exists public.info_page_contributors (
  info_page_id uuid not null references public.info_pages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  contributed_at timestamptz not null default now(),
  primary key(info_page_id, user_id)
);

create table if not exists public.info_page_review_events (
  id uuid primary key default gen_random_uuid(),
  info_page_id uuid references public.info_pages(id) on delete cascade,
  info_page_update_id uuid references public.info_page_updates(id) on delete cascade,
  action text not null,
  notes text,
  performed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists info_review_events_page_idx on public.info_page_review_events(info_page_id, created_at);

create table if not exists public.info_search_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  query text,
  filters jsonb not null default '{}'::jsonb,
  result_count integer,
  created_at timestamptz not null default now()
);
create index if not exists info_search_events_created_idx on public.info_search_events(created_at desc);

create table if not exists public.info_search_click_events (
  id uuid primary key default gen_random_uuid(),
  search_event_id uuid references public.info_search_events(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  clicked_page_id uuid references public.info_pages(id) on delete set null,
  query text,
  position integer,
  created_at timestamptz not null default now()
);
create index if not exists info_search_click_events_created_idx on public.info_search_click_events(created_at desc);

create table if not exists public.info_admin_todos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'done')),
  related_info_page_id uuid references public.info_pages(id) on delete set null,
  related_info_page_slug text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  done_by_name text,
  resolution_notes text,
  content_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists info_admin_todos_status_idx on public.info_admin_todos(status, created_at);

create table if not exists public.dm_threads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_thread_members (
  thread_id uuid not null references public.dm_threads(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_at timestamptz,
  primary key(thread_id, user_id)
);
create index if not exists dm_thread_members_user_idx on public.dm_thread_members(user_id, left_at);

create table if not exists public.dm_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.dm_threads(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  body text not null,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dm_messages_thread_idx on public.dm_messages(thread_id, created_at);
create index if not exists dm_messages_author_idx on public.dm_messages(created_by, created_at desc);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('user', 'forum_post', 'forum_thread', 'dm_thread')),
  target_id text not null,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'open',
  category text,
  reason text not null,
  assigned_to uuid references auth.users(id) on delete set null,
  escalated_at timestamptz,
  escalated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports(status, created_at desc);
create index if not exists reports_reporter_idx on public.reports(reporter_user_id, created_at desc);

create table if not exists public.report_messages (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  message text not null,
  kind text not null default 'reporter',
  created_at timestamptz not null default now()
);
create index if not exists report_messages_report_idx on public.report_messages(report_id, created_at);

create table if not exists public.moderation_recycle_bin (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('thread', 'post', 'dm_message')),
  original_table text not null,
  original_id text not null,
  payload jsonb not null default '{}'::jsonb,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  restored_at timestamptz,
  unique(original_table, original_id)
);
create index if not exists moderation_recycle_bin_expires_at_idx on public.moderation_recycle_bin(expires_at);
create index if not exists moderation_recycle_bin_deleted_by_idx on public.moderation_recycle_bin(deleted_by);

-- The vendors module existed separately, but a complete baseline must also repair
-- installations where it was selected in the wizard without running its DDL.
create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  url text,
  logo_url text,
  tags text[] not null default '{}',
  featured boolean not null default false,
  is_published boolean not null default true,
  trust_status text not null default 'unknown' check (trust_status in ('trusted', 'untrusted', 'unknown')),
  warning_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shops_slug_lower_idx on public.shops(lower(slug));
create index if not exists shops_public_order_idx on public.shops(is_published, featured desc, sort_order, created_at desc);
create index if not exists shops_tags_idx on public.shops using gin(tags);

create or replace function public.contains_profanity(input_text text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select false
$$;

create or replace function public.get_site_lockdown_flags()
returns table (
  lockdown_enabled boolean,
  lockdown_message text,
  force_logout_epoch bigint,
  maintenance_mode boolean,
  lockdown_version integer,
  emergency_banner_enabled boolean,
  emergency_banner_text text,
  emergency_banner_level text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.lockdown_enabled, s.lockdown_message, s.force_logout_epoch,
    s.maintenance_mode, s.lockdown_version, s.emergency_banner_enabled,
    s.emergency_banner_text, s.emergency_banner_level
  from public.site_security_settings s
  where s.id = 1
$$;

create or replace function public.check_lockdown_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    (
      select case
        when s.lockdown_password is null or s.lockdown_password = '' then false
        when s.lockdown_password ~ '^\$2[aby]\$'
          then extensions.crypt(p_password, s.lockdown_password) = s.lockdown_password
        else p_password = s.lockdown_password
      end
      from public.site_security_settings s
      where s.id = 1
    ),
    false
  )
$$;

create or replace function public.verify_admin_override_password(p_password text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(
    (
      select case
        when s.admin_override_password is null or s.admin_override_password = '' then false
        when s.admin_override_password ~ '^\$2[aby]\$'
          then extensions.crypt(p_password, s.admin_override_password) = s.admin_override_password
        else p_password = s.admin_override_password
      end
      from public.site_security_settings s where s.id = 1
    ),
    false
  )
$$;

create or replace function public.increment_thread_view(p_thread_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.forum_threads set view_count = view_count + 1 where id = p_thread_id and not is_deleted;
end
$$;

create or replace function public.apply_post_vote(
  p_post_id bigint,
  p_voter_user_id uuid,
  p_value smallint
)
returns table (vote_score integer, upvote_count integer, downvote_count integer, my_vote smallint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  post_author uuid;
begin
  if p_voter_user_id is null or p_value not in (-1, 0, 1) then
    raise exception 'INVALID_VOTE' using errcode = '22023';
  end if;
  select created_by into post_author from public.forum_posts where id = p_post_id and not is_deleted;
  if post_author is null then raise exception 'POST_NOT_FOUND' using errcode = 'P0002'; end if;
  if post_author = p_voter_user_id then raise exception 'CANNOT_VOTE_OWN_POST' using errcode = '42501'; end if;

  if p_value = 0 then
    delete from public.forum_post_votes where post_id = p_post_id and user_id = p_voter_user_id;
  else
    insert into public.forum_post_votes(post_id, user_id, value)
    values (p_post_id, p_voter_user_id, p_value)
    on conflict (post_id, user_id) do update set value = excluded.value;
  end if;

  update public.forum_posts p
  set vote_score = totals.score,
      upvote_count = totals.ups,
      downvote_count = totals.downs
  from (
    select coalesce(sum(value), 0)::integer score,
      count(*) filter (where value = 1)::integer ups,
      count(*) filter (where value = -1)::integer downs
    from public.forum_post_votes where post_id = p_post_id
  ) totals
  where p.id = p_post_id;

  return query
  select p.vote_score, p.upvote_count, p.downvote_count, p_value
  from public.forum_posts p where p.id = p_post_id;
end
$$;

create or replace function public.award_accepted_answer_karma(
  p_thread_id bigint,
  p_post_id bigint,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles p
  set karma = karma + 10
  from public.forum_posts fp
  where fp.id = p_post_id and p.id = fp.created_by;
end
$$;

create or replace function public.revoke_accepted_answer_karma(p_thread_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles p
  set karma = greatest(0, karma - 10)
  from public.forum_posts fp
  join public.forum_threads ft on ft.accepted_post_id = fp.id
  where ft.id = p_thread_id and p.id = fp.created_by;
end
$$;

create or replace function public.search_info_pages(
  q text,
  limit_results integer default 25
)
returns setof public.info_pages
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.*
  from public.info_pages p
  where p.status = 'published'
    and (
      coalesce(trim(q), '') = ''
      or p.title ilike '%' || q || '%'
      or p.content_markdown ilike '%' || q || '%'
      or exists (select 1 from unnest(p.tags) t where t ilike '%' || q || '%')
    )
  order by p.updated_at desc
  limit greatest(1, least(coalesce(limit_results, 25), 100))
$$;

create or replace function public.dm_get_or_create_thread(p_other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  found_thread uuid;
begin
  if viewer is null or p_other_user_id is null or viewer = p_other_user_id then
    raise exception 'INVALID_PARTICIPANT' using errcode = '22023';
  end if;
  if not public.is_account_admitted() then
    raise exception 'ACCOUNT_ADMISSION_REQUIRED' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.user_blocks
    where (blocker_user_id = viewer and blocked_user_id = p_other_user_id)
       or (blocker_user_id = p_other_user_id and blocked_user_id = viewer)
  ) then
    raise exception 'USER_BLOCKED' using errcode = '42501';
  end if;
  select m.thread_id into found_thread
  from public.dm_thread_members m
  join public.dm_thread_members other on other.thread_id = m.thread_id
  where m.user_id = viewer and m.left_at is null
    and other.user_id = p_other_user_id and other.left_at is null
    and (select count(*) from public.dm_thread_members x where x.thread_id = m.thread_id and x.left_at is null) = 2
  limit 1;
  if found_thread is null then
    insert into public.dm_threads default values returning id into found_thread;
    insert into public.dm_thread_members(thread_id, user_id)
    values (found_thread, viewer), (found_thread, p_other_user_id);
  end if;
  return found_thread;
end
$$;

create or replace function public.dm_send_message(p_thread_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  message_id uuid;
begin
  if viewer is null or not public.is_account_admitted() then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.dm_thread_members
    where thread_id = p_thread_id and user_id = viewer and left_at is null
  ) then
    raise exception 'NOT_A_MEMBER' using errcode = '42501';
  end if;
  if exists (
    select 1
    from public.dm_thread_members other
    join public.user_blocks b on
      (b.blocker_user_id = viewer and b.blocked_user_id = other.user_id)
      or (b.blocker_user_id = other.user_id and b.blocked_user_id = viewer)
    where other.thread_id = p_thread_id and other.user_id <> viewer and other.left_at is null
  ) then
    raise exception 'USER_BLOCKED' using errcode = '42501';
  end if;
  insert into public.dm_messages(thread_id, created_by, body)
  values (p_thread_id, viewer, trim(p_body))
  returning id into message_id;
  update public.dm_threads set updated_at = now() where id = p_thread_id;
  return message_id;
end
$$;

create or replace function public.dm_mark_thread_read(p_thread_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.dm_thread_members
  set last_read_at = now()
  where thread_id = p_thread_id and user_id = auth.uid() and left_at is null
$$;

create or replace function public.dm_mark_all_read()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.dm_thread_members set last_read_at = now()
  where user_id = auth.uid() and left_at is null
$$;

create or replace function public.dm_leave_thread(p_thread_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.dm_thread_members set left_at = now()
  where thread_id = p_thread_id and user_id = auth.uid()
$$;

create or replace function public.dm_unread_thread_count()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.dm_thread_members m
  where m.user_id = auth.uid() and m.left_at is null
    and exists (
      select 1 from public.dm_messages msg
      where msg.thread_id = m.thread_id
        and msg.created_by <> auth.uid()
        and not msg.is_deleted
        and msg.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)
    )
$$;

create or replace function public.dm_list_threads(p_limit integer default 50, p_offset integer default 0)
returns table (
  thread_id uuid,
  other_user_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_url text,
  last_message_body text,
  last_message_at timestamptz,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    mine.thread_id,
    other.user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    last_msg.body,
    last_msg.created_at,
    (
      select count(*)
      from public.dm_messages unread
      where unread.thread_id = mine.thread_id
        and unread.created_by <> auth.uid()
        and not unread.is_deleted
        and unread.created_at > coalesce(mine.last_read_at, '-infinity'::timestamptz)
    )
  from public.dm_thread_members mine
  join public.dm_thread_members other
    on other.thread_id = mine.thread_id and other.user_id <> mine.user_id and other.left_at is null
  left join public.profiles p on p.id = other.user_id
  left join lateral (
    select msg.body, msg.created_at
    from public.dm_messages msg
    where msg.thread_id = mine.thread_id and not msg.is_deleted
    order by msg.created_at desc limit 1
  ) last_msg on true
  where mine.user_id = auth.uid() and mine.left_at is null
  order by last_msg.created_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(coalesce(p_offset, 0), 0)
$$;

create or replace function public.dm_get_thread(p_thread_id uuid, p_limit integer default 100, p_before timestamptz default null)
returns table (
  thread_id uuid,
  other_user_id uuid,
  other_username text,
  other_display_name text,
  other_avatar_url text,
  last_message_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select mine.thread_id, other.user_id, p.username, p.display_name, p.avatar_url,
    (select max(msg.created_at) from public.dm_messages msg where msg.thread_id = mine.thread_id)
  from public.dm_thread_members mine
  join public.dm_thread_members other
    on other.thread_id = mine.thread_id and other.user_id <> mine.user_id and other.left_at is null
  left join public.profiles p on p.id = other.user_id
  where mine.thread_id = p_thread_id and mine.user_id = auth.uid() and mine.left_at is null
$$;

create or replace function public.purge_expired_moderation_recycle_bin()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count bigint;
begin
  delete from public.moderation_recycle_bin where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end
$$;

-- Lock privileged functions down before granting their intended callers.
revoke all on function public.increment_thread_view(bigint) from public;
revoke all on function public.apply_post_vote(bigint, uuid, smallint) from public;
revoke all on function public.award_accepted_answer_karma(bigint, bigint, uuid) from public;
revoke all on function public.revoke_accepted_answer_karma(bigint) from public;
revoke all on function public.dm_get_or_create_thread(uuid) from public;
revoke all on function public.dm_send_message(uuid, text) from public;
revoke all on function public.dm_mark_thread_read(uuid) from public;
revoke all on function public.dm_mark_all_read() from public;
revoke all on function public.dm_leave_thread(uuid) from public;
revoke all on function public.dm_unread_thread_count() from public;
revoke all on function public.dm_list_threads(integer, integer) from public;
revoke all on function public.dm_get_thread(uuid, integer, timestamptz) from public;
revoke all on function public.get_site_lockdown_flags() from public;
revoke all on function public.check_lockdown_password(text) from public;
revoke all on function public.verify_admin_override_password(text) from public;
revoke all on function public.purge_expired_moderation_recycle_bin() from public, anon, authenticated;
grant execute on function public.increment_thread_view(bigint) to anon, authenticated;
grant execute on function public.apply_post_vote(bigint, uuid, smallint) to service_role;
grant execute on function public.award_accepted_answer_karma(bigint, bigint, uuid) to service_role;
grant execute on function public.revoke_accepted_answer_karma(bigint) to service_role;
grant execute on function public.search_info_pages(text, integer) to anon, authenticated;
grant execute on function public.dm_get_or_create_thread(uuid) to authenticated;
grant execute on function public.dm_send_message(uuid, text) to authenticated;
grant execute on function public.dm_mark_thread_read(uuid) to authenticated;
grant execute on function public.dm_mark_all_read() to authenticated;
grant execute on function public.dm_leave_thread(uuid) to authenticated;
grant execute on function public.dm_unread_thread_count() to authenticated;
grant execute on function public.dm_list_threads(integer, integer) to authenticated;
grant execute on function public.dm_get_thread(uuid, integer, timestamptz) to authenticated;
grant execute on function public.get_site_lockdown_flags() to anon, authenticated;
grant execute on function public.check_lockdown_password(text) to anon, authenticated;
grant execute on function public.verify_admin_override_password(text) to service_role;
grant execute on function public.purge_expired_moderation_recycle_bin() to service_role;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'audit_logs','auth_login_events','user_blocks','user_restrictions','site_verified_perks',
    'admin_action_requests','notifications','forum_categories','forum_threads','forum_posts',
    'forum_post_votes','forum_flags','forum_moderators','forum_thread_lead_scores','info_pages',
    'info_page_drafts','info_page_updates','info_page_contributors','info_page_review_events',
    'info_search_events','info_search_click_events','info_admin_todos','dm_threads',
    'dm_thread_members','dm_messages','reports','report_messages','moderation_recycle_bin','shops'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end
$$;

-- Public content.
grant select on public.forum_categories, public.forum_threads, public.forum_posts, public.forum_post_votes,
  public.info_pages, public.shops to anon, authenticated;
grant select, insert, update, delete on public.user_blocks to authenticated;
grant select, insert, update, delete on public.info_page_drafts to authenticated;
grant insert on public.info_search_events, public.info_search_click_events to anon, authenticated;
grant select, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.forum_post_votes, public.forum_flags to authenticated;
grant select, update on public.site_security_settings to authenticated;
grant select, insert, update, delete on public.forum_categories, public.forum_threads, public.forum_posts,
  public.info_pages, public.info_page_updates, public.info_page_contributors, public.info_page_review_events,
  public.info_admin_todos, public.shops to authenticated;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_categories' and policyname='forum categories readable') then
    create policy "forum categories readable" on public.forum_categories for select to anon, authenticated using (not is_archived or public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_threads' and policyname='forum threads readable') then
    create policy "forum threads readable" on public.forum_threads for select to anon, authenticated using (not is_deleted);
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_posts' and policyname='forum posts readable') then
    create policy "forum posts readable" on public.forum_posts for select to anon, authenticated using (not is_deleted);
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_post_votes' and policyname='forum votes readable') then
    create policy "forum votes readable" on public.forum_post_votes for select to anon, authenticated using (true);
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_post_votes' and policyname='own forum votes') then
    create policy "own forum votes" on public.forum_post_votes for all to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='forum_flags' and policyname='own forum flags') then
    create policy "own forum flags" on public.forum_flags for all to authenticated
      using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()) and public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='info_pages' and policyname='published info readable') then
    create policy "published info readable" on public.info_pages for select to anon, authenticated using (status in ('approved', 'published') or created_by = (select auth.uid()));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='info_page_drafts' and policyname='own info drafts') then
    create policy "own info drafts" on public.info_page_drafts for all to authenticated
      using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()) and public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='notifications' and policyname='own notifications') then
    create policy "own notifications" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
    create policy "update own notifications" on public.notifications for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
    create policy "delete own notifications" on public.notifications for delete to authenticated using (user_id = (select auth.uid()));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='user_blocks' and policyname='own blocks') then
    create policy "own blocks" on public.user_blocks for all to authenticated
      using (blocker_user_id = (select auth.uid())) with check (blocker_user_id = (select auth.uid()) and public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='shops' and policyname='published shops read') then
    create policy "published shops read" on public.shops for select to anon, authenticated using (is_published);
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='site_security_settings' and policyname='staff security settings') then
    create policy "staff security settings" on public.site_security_settings for all to authenticated
      using (public.is_staff_user()) with check (public.is_staff_user());
  end if;
end $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'audit_logs','auth_login_events','user_restrictions','site_verified_perks',
    'admin_action_requests','forum_categories','forum_threads','forum_posts','forum_flags',
    'forum_moderators','forum_thread_lead_scores','info_pages','info_page_updates',
    'info_page_contributors','info_page_review_events','info_search_events',
    'info_search_click_events','info_admin_todos','reports','report_messages',
    'moderation_recycle_bin','shops'
  ]
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = table_name and policyname = 'staff manage'
    ) then
      execute format(
        'create policy "staff manage" on public.%I for all to authenticated using (public.is_staff_user()) with check (public.is_staff_user())',
        table_name
      );
    end if;
  end loop;
end
$$;

-- Server routes use the service role for authorization-checked operations.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

insert into public.schema_versions(module_key, version, checksum) values
  ('audit_security', 1, 'application-baseline-v1'),
  ('notifications', 1, 'application-baseline-v1'),
  ('moderation', 1, 'application-baseline-v1'),
  ('forum', 1, 'application-baseline-v1'),
  ('knowledge_base', 1, 'application-baseline-v1'),
  ('garage', 1, 'application-baseline-v1'),
  ('messaging', 1, 'application-baseline-v1'),
  ('vendors', 1, 'application-baseline-v1')
on conflict (module_key, version) do nothing;

insert into public.installed_modules(module_key, enabled, schema_version)
select module_key, true, 1
from (values
  ('audit_security'),
  ('notifications'),
  ('moderation'),
  ('forum'),
  ('knowledge_base'),
  ('garage'),
  ('messaging'),
  ('vendors')
) modules(module_key)
on conflict (module_key) do update
set enabled = true, schema_version = greatest(public.installed_modules.schema_version, excluded.schema_version), disabled_at = null;

notify pgrst, 'reload schema';
commit;
\ir modules/commerce.sql
