-- Additive moderation durability baseline. Apply to staging before production.
create table if not exists public.moderation_recycle_bin (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in ('thread', 'post', 'dm_message')),
  original_table text not null,
  original_id text not null,
  payload jsonb not null default '{}'::jsonb,
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (original_table, original_id)
);

create index if not exists moderation_recycle_bin_expires_at_idx
  on public.moderation_recycle_bin (expires_at);
create index if not exists moderation_recycle_bin_deleted_by_idx
  on public.moderation_recycle_bin (deleted_by);

alter table public.moderation_recycle_bin enable row level security;
-- Deliberately no authenticated/anon policies: access is restricted to authorized
-- server routes using the service role. The service role bypasses RLS.

alter table public.reports
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_by uuid references auth.users(id) on delete set null;

create index if not exists reports_escalated_at_idx
  on public.reports (escalated_at) where escalated_at is not null;

create or replace function public.purge_expired_moderation_recycle_bin()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count bigint;
begin
  delete from public.moderation_recycle_bin where expires_at <= now();
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.purge_expired_moderation_recycle_bin() from public, anon, authenticated;
grant execute on function public.purge_expired_moderation_recycle_bin() to service_role;

-- Schedule daily cleanup when pg_cron is already enabled. Projects without it can
-- call the function daily from a protected Vercel cron route in a later migration.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'purge-expired-moderation-recycle-bin') then
      perform cron.schedule(
        'purge-expired-moderation-recycle-bin',
        '17 3 * * *',
        'select public.purge_expired_moderation_recycle_bin()'
      );
    end if;
  end if;
end;
$$;
