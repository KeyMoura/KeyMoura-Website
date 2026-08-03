-- Recovered file. This migration was applied to production on 2026-07-31 and is
-- recorded in supabase_migrations.schema_migrations as version 20260731100000,
-- but its file was missing from the repository. The body below is reconstructed
-- verbatim from the `statements` array stored with that ledger row, so a fresh
-- environment rebuilds the same schema the live database already has.
--
-- Every statement is idempotent; the recorded row means it is never replayed
-- against production.

begin;

-- Complete the notification relation used by both the full page and header bell.
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

alter table public.notifications enable row level security;

grant select, update, delete on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications to service_role;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notifications' and policyname='own notifications') then
    create policy "own notifications" on public.notifications for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notifications' and policyname='update own notifications') then
    create policy "update own notifications" on public.notifications for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='notifications' and policyname='delete own notifications') then
    create policy "delete own notifications" on public.notifications for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;
end $$;

-- This staff relation was absent from some partially installed projects.
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

alter table public.info_admin_todos enable row level security;

grant select, insert, update, delete on public.info_admin_todos to authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='info_admin_todos' and policyname='staff manage') then
    create policy "staff manage" on public.info_admin_todos for all to authenticated
      using ((select public.is_staff_user())) with check ((select public.is_staff_user()));
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
