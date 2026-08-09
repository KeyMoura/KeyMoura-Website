begin;

create table public.guest_order_access_codes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  code_digest text not null check (char_length(code_digest) between 40 and 100),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 5),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now()
);
create index guest_order_access_codes_order_created_idx on public.guest_order_access_codes(order_id, created_at desc);
create unique index guest_order_access_codes_one_active_idx on public.guest_order_access_codes(order_id) where consumed_at is null;

alter table public.guest_order_access_codes enable row level security;
revoke all on public.guest_order_access_codes from public, anon, authenticated;
grant select, insert, update, delete on public.guest_order_access_codes to service_role;

create or replace function public.replace_guest_order_access_code(p_order_id uuid, p_code_digest text, p_expires_at timestamptz, p_cooldown_seconds integer)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare latest_created timestamptz; result uuid;
begin
  perform 1 from public.orders where id = p_order_id and customer_id is null and guest_email is not null for update;
  if not found then raise exception 'unavailable' using errcode = 'P0002'; end if;
  select created_at into latest_created from public.guest_order_access_codes where order_id = p_order_id order by created_at desc limit 1;
  if latest_created is not null and latest_created > clock_timestamp() - make_interval(secs => p_cooldown_seconds) then
    raise exception 'cooldown' using errcode = 'P0001';
  end if;
  update public.guest_order_access_codes set consumed_at = clock_timestamp() where order_id = p_order_id and consumed_at is null;
  insert into public.guest_order_access_codes(order_id, code_digest, expires_at) values(p_order_id, p_code_digest, p_expires_at) returning id into result;
  return result;
end $$;

create or replace function public.record_guest_order_code_failure(p_code_id uuid, p_max_attempts integer)
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.guest_order_access_codes set failed_attempts = least(failed_attempts + 1, p_max_attempts), last_attempt_at = clock_timestamp()
  where id = p_code_id and consumed_at is null and expires_at > clock_timestamp() and failed_attempts < p_max_attempts
$$;

create or replace function public.consume_guest_order_access_code(p_code_id uuid, p_order_id uuid, p_session_digest text, p_session_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.guest_order_access_codes set consumed_at = clock_timestamp()
  where id = p_code_id and order_id = p_order_id and consumed_at is null and expires_at > clock_timestamp() and failed_attempts < 5;
  if not found then return false; end if;
  update public.orders set guest_token_hash = p_session_digest, guest_access_expires_at = p_session_expires_at
  where id = p_order_id and customer_id is null and guest_email is not null;
  return found;
end $$;

revoke all on function public.replace_guest_order_access_code(uuid,text,timestamptz,integer) from public, anon, authenticated;
revoke all on function public.record_guest_order_code_failure(uuid,integer) from public, anon, authenticated;
revoke all on function public.consume_guest_order_access_code(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.replace_guest_order_access_code(uuid,text,timestamptz,integer) to service_role;
grant execute on function public.record_guest_order_code_failure(uuid,integer) to service_role;
grant execute on function public.consume_guest_order_access_code(uuid,uuid,text,timestamptz) to service_role;

insert into public.email_templates(key,name,subject,heading,body,button_label) values
('guest_order_access','Guest order access','Your KeyMoura order verification code','View your order','Use the verification code below to securely open your guest order.','View your order')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
commit;
