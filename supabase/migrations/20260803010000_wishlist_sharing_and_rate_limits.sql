-- Wishlist share expiry and a durable rate limiter.
--
-- Additive. Nothing here changes an existing column or policy.
--
-- The wishlist tables already carry `share_token` and `is_public` from
-- 20260802020200; the only thing missing for a revocable, optionally expiring
-- share link is the expiry itself.

begin;

alter table public.wishlists
  add column if not exists share_expires_at timestamptz,
  add column if not exists shared_at timestamptz;

/*
 * Application-level rate limiting.
 *
 * In-memory counters are worthless on serverless: every instance keeps its own,
 * so the real limit is the configured one multiplied by however many instances
 * happen to be warm. This table is the shared counter.
 *
 * `subject` is always a salted hash of the identity, never the identity itself.
 * A guest cart token is a bearer credential, and a user id is personal data;
 * neither belongs in a table whose whole purpose is to be written to on every
 * anonymous request.
 */
create table if not exists public.rate_limit_hits (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  constraint rate_limit_hits_bucket_shape check (bucket ~ '^[a-z0-9_.]{3,60}$'),
  constraint rate_limit_hits_subject_shape check (char_length(subject) between 16 and 128)
);

create index if not exists rate_limit_hits_window_idx
  on public.rate_limit_hits (bucket, subject, created_at desc);

-- Sweep index for the opportunistic cleanup below.
create index if not exists rate_limit_hits_age_idx on public.rate_limit_hits (created_at);

/*
 * Counts and records one attempt atomically.
 *
 * The transaction-scoped advisory lock is keyed on the bucket and subject, so
 * concurrent requests from the *same* caller serialize while unrelated callers
 * never contend. Without it two simultaneous requests both read the count
 * below the limit and both proceed, which is exactly the burst a limiter on a
 * share-link endpoint exists to stop.
 *
 * Returns a result rather than raising so callers can answer with a clean
 * message and a Retry-After.
 */
create or replace function public.consume_rate_limit(
  p_bucket text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_start timestamptz := now() - make_interval(secs => greatest(p_window_seconds, 1));
  used integer;
  oldest timestamptz;
begin
  if p_limit <= 0 then
    return jsonb_build_object('allowed', false, 'remaining', 0, 'retry_after_seconds', p_window_seconds);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_bucket || ':' || p_subject, 0));

  -- Opportunistic cleanup: keeps the table bounded without a scheduled job.
  -- Scoped to this subject so it never turns into a full-table scan.
  delete from public.rate_limit_hits
  where bucket = p_bucket and subject = p_subject and created_at < window_start;

  select count(*), min(created_at) into used, oldest
  from public.rate_limit_hits
  where bucket = p_bucket and subject = p_subject and created_at >= window_start;

  if used >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (oldest + make_interval(secs => p_window_seconds)) - now()))::integer)
    );
  end if;

  insert into public.rate_limit_hits (bucket, subject) values (p_bucket, p_subject);

  return jsonb_build_object('allowed', true, 'remaining', p_limit - used - 1, 'retry_after_seconds', 0);
end;
$$;

alter table public.rate_limit_hits enable row level security;

-- No anon or authenticated policy. The limiter is reached only from server
-- routes acting with the service role; a client that could read or delete
-- these rows could erase its own limit.
revoke all on public.rate_limit_hits from anon, authenticated;
grant select, insert, update, delete on public.rate_limit_hits to service_role;

revoke all on function public.consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
