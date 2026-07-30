-- Dedicated browsing activity for mini-profiles. Existing profiles remain compatible
-- because the timestamp is nullable; profile updated_at and auth sign-in data are not used.
alter table public.profiles
  add column if not exists last_seen_at timestamptz;

create index if not exists profiles_last_seen_at_idx
  on public.profiles (last_seen_at desc)
  where last_seen_at is not null;

-- SECURITY DEFINER deliberately avoids granting clients general profile UPDATE access.
-- auth.uid() fixes the target row, and the database-side guard also limits abusive calls.
create or replace function public.touch_last_seen()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  touched_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  update public.profiles
  set last_seen_at = clock_timestamp()
  where id = auth.uid()
    and (last_seen_at is null or last_seen_at <= clock_timestamp() - interval '5 minutes')
  returning last_seen_at into touched_at;

  return touched_at;
end;
$$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

comment on column public.profiles.last_seen_at is
  'Last meaningful authenticated browsing activity; nullable for users not yet observed.';
comment on function public.touch_last_seen() is
  'Records only the caller activity, with a database-enforced five-minute throttle.';
