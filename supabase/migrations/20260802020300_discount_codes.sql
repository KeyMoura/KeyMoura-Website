-- Application-owned discount codes.
--
-- Additive. Eligibility and the discount amount are always computed by the
-- application from live data; Stripe only ever receives an already-validated
-- final amount. Redemption is atomic so a burst of concurrent checkouts cannot
-- push a code past its usage limit.

begin;

create table if not exists public.discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  description text,
  discount_type text not null,
  discount_value integer not null,
  max_discount_cents integer,
  minimum_subtotal_cents integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  max_total_uses integer,
  max_uses_per_customer integer,
  first_order_only boolean not null default false,
  is_stackable boolean not null default false,
  total_uses integer not null default 0,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint discount_codes_code_shape check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  constraint discount_codes_type_check check (discount_type in ('fixed', 'percent')),
  constraint discount_codes_value_check check (
    (discount_type = 'fixed' and discount_value > 0)
    or (discount_type = 'percent' and discount_value between 1 and 100)
  ),
  constraint discount_codes_window_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint discount_codes_limits_check check (
    (max_total_uses is null or max_total_uses > 0)
    and (max_uses_per_customer is null or max_uses_per_customer > 0)
    and minimum_subtotal_cents >= 0
    and (max_discount_cents is null or max_discount_cents > 0)
  )
);

create unique index if not exists discount_codes_code_key on public.discount_codes (upper(code));

-- Product and category targeting, plus exclusions. With no rows a code applies
-- to the whole cart.
create table if not exists public.discount_code_targets (
  id uuid primary key default gen_random_uuid(),
  discount_code_id uuid not null references public.discount_codes(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  is_exclusion boolean not null default false,
  created_at timestamptz not null default now(),
  constraint discount_code_targets_type_check check (target_type in ('product', 'category'))
);

create unique index if not exists discount_code_targets_unique
  on public.discount_code_targets (discount_code_id, target_type, target_id, is_exclusion);

create table if not exists public.discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_code_id uuid not null references public.discount_codes(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  customer_id uuid references auth.users(id) on delete set null,
  amount_cents integer not null,
  created_at timestamptz not null default now(),
  constraint discount_redemptions_amount_check check (amount_cents >= 0)
);

create unique index if not exists discount_redemptions_order_code_key
  on public.discount_redemptions (order_id, discount_code_id);
create index if not exists discount_redemptions_customer_idx
  on public.discount_redemptions (discount_code_id, customer_id);

-- Atomic redemption. Locks the code row, re-checks the total and per-customer
-- limits under that lock, then records the redemption and bumps the counter.
-- Returns a JSON result rather than raising so callers can report a clean
-- message. Concurrent checkouts serialize on the row lock, so the last unit of
-- a nearly exhausted code cannot be handed out twice.
create or replace function public.redeem_discount_code(
  p_code_id uuid,
  p_order_id uuid,
  p_customer_id uuid,
  p_amount_cents integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  code_row public.discount_codes%rowtype;
  customer_uses integer;
  inserted_count integer;
begin
  select * into code_row from public.discount_codes where id = p_code_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'unknown_code');
  end if;

  if not code_row.is_active or code_row.archived_at is not null then
    return jsonb_build_object('applied', false, 'reason', 'inactive');
  end if;
  if code_row.starts_at is not null and code_row.starts_at > now() then
    return jsonb_build_object('applied', false, 'reason', 'not_started');
  end if;
  if code_row.ends_at is not null and code_row.ends_at <= now() then
    return jsonb_build_object('applied', false, 'reason', 'expired');
  end if;
  if code_row.max_total_uses is not null and code_row.total_uses >= code_row.max_total_uses then
    return jsonb_build_object('applied', false, 'reason', 'exhausted');
  end if;

  if code_row.max_uses_per_customer is not null and p_customer_id is not null then
    select count(*) into customer_uses
    from public.discount_redemptions
    where discount_code_id = p_code_id and customer_id = p_customer_id;

    if customer_uses >= code_row.max_uses_per_customer then
      return jsonb_build_object('applied', false, 'reason', 'customer_limit');
    end if;
  end if;

  insert into public.discount_redemptions (discount_code_id, order_id, customer_id, amount_cents)
  values (p_code_id, p_order_id, p_customer_id, greatest(p_amount_cents, 0))
  on conflict (order_id, discount_code_id) do nothing;

  -- FOUND is not a reliable signal after INSERT ... ON CONFLICT DO NOTHING;
  -- read the actual affected-row count instead so a repeat call is detected.
  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    return jsonb_build_object('applied', false, 'reason', 'already_redeemed');
  end if;

  update public.discount_codes
  set total_uses = total_uses + 1, updated_at = now()
  where id = p_code_id;

  return jsonb_build_object('applied', true, 'amount_cents', greatest(p_amount_cents, 0));
end;
$$;

-- Releases a redemption when an order never gets paid, so an abandoned
-- checkout does not permanently consume a limited code.
create or replace function public.release_discount_redemption(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  redemption record;
begin
  for redemption in
    select discount_code_id from public.discount_redemptions where order_id = p_order_id
  loop
    update public.discount_codes
    set total_uses = greatest(total_uses - 1, 0), updated_at = now()
    where id = redemption.discount_code_id;
  end loop;

  delete from public.discount_redemptions where order_id = p_order_id;
end;
$$;

alter table public.discount_codes enable row level security;
alter table public.discount_code_targets enable row level security;
alter table public.discount_redemptions enable row level security;

-- No anon or authenticated policy. Customers never read the discount tables
-- directly; they submit a code and the server answers with an amount and a
-- reason. That keeps the full code list, its limits, and its targeting private.
revoke all on public.discount_codes from anon, authenticated;
revoke all on public.discount_code_targets from anon, authenticated;
revoke all on public.discount_redemptions from anon, authenticated;

grant select, insert, update, delete on public.discount_codes to service_role;
grant select, insert, update, delete on public.discount_code_targets to service_role;
grant select, insert, update, delete on public.discount_redemptions to service_role;

revoke all on function public.redeem_discount_code(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.redeem_discount_code(uuid, uuid, uuid, integer) to service_role;
revoke all on function public.release_discount_redemption(uuid) from public, anon, authenticated;
grant execute on function public.release_discount_redemption(uuid) to service_role;

insert into public.permissions(key, name, description) values
  ('catalog.discounts.manage', 'Manage discount codes', 'Create, edit, target, and archive discount codes')
on conflict(key) do update set name = excluded.name, description = excluded.description;

insert into public.role_permissions(role_key, permission_key)
values ('admin', 'catalog.discounts.manage')
on conflict do nothing;

notify pgrst, 'reload schema';

commit;
