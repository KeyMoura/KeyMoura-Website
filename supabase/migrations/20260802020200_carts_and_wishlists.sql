-- Carts, shared cart snapshots, and wishlists.
--
-- Additive.
--
-- Cart and wishlist items deliberately store no prices. Every price, option
-- surcharge, discount, and total is derived server-side from live product rows
-- at display and again at checkout, so a tampered client payload cannot change
-- what anyone is charged.

begin;

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete cascade,
  guest_token text,
  status text not null default 'active',
  converted_order_id uuid references public.orders(id) on delete set null,
  discount_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_status_check check (status in ('active', 'converted', 'abandoned')),
  -- A cart belongs to exactly one of an account or a guest token.
  constraint carts_owner_check check (
    (customer_id is not null and guest_token is null)
    or (customer_id is null and guest_token is not null)
  )
);

create unique index if not exists carts_active_customer_key
  on public.carts (customer_id) where status = 'active' and customer_id is not null;
create unique index if not exists carts_guest_token_key
  on public.carts (guest_token) where guest_token is not null;

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null default 1,
  selected_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cart_items_quantity_check check (quantity between 1 and 99)
);

create index if not exists cart_items_cart_idx on public.cart_items (cart_id);

-- Shared carts are immutable snapshots, never a handle on someone's live cart.
-- The row carries no owner identity beyond a nullable creator used only for
-- revocation, and that column is never exposed by the public read path.
create table if not exists public.shared_carts (
  id uuid primary key default gen_random_uuid(),
  token text not null,
  created_by uuid references auth.users(id) on delete set null,
  items jsonb not null default '[]'::jsonb,
  note text,
  expires_at timestamptz,
  revoked_at timestamptz,
  view_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint shared_carts_token_length check (char_length(token) >= 32)
);

create unique index if not exists shared_carts_token_key on public.shared_carts (token);
create index if not exists shared_carts_creator_idx on public.shared_carts (created_by, created_at desc);

create table if not exists public.wishlists (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete cascade,
  guest_token text,
  share_token text,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wishlists_owner_check check (
    (customer_id is not null and guest_token is null)
    or (customer_id is null and guest_token is not null)
  ),
  constraint wishlists_share_token_length check (share_token is null or char_length(share_token) >= 32)
);

create unique index if not exists wishlists_customer_key
  on public.wishlists (customer_id) where customer_id is not null;
create unique index if not exists wishlists_guest_token_key
  on public.wishlists (guest_token) where guest_token is not null;
create unique index if not exists wishlists_share_token_key
  on public.wishlists (share_token) where share_token is not null;

create table if not exists public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  wishlist_id uuid not null references public.wishlists(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  selected_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists wishlist_items_unique
  on public.wishlist_items (wishlist_id, product_id);

-- Row level security with no anon or authenticated policy: all four tables are
-- reached only through server routes that resolve ownership from the session
-- cookie or a signed guest cookie, then act with the service role. A guest
-- cart token in a browser must never be usable as a direct database key.
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.shared_carts enable row level security;
alter table public.wishlists enable row level security;
alter table public.wishlist_items enable row level security;

revoke all on public.carts from anon, authenticated;
revoke all on public.cart_items from anon, authenticated;
revoke all on public.shared_carts from anon, authenticated;
revoke all on public.wishlists from anon, authenticated;
revoke all on public.wishlist_items from anon, authenticated;

grant select, insert, update, delete on public.carts to service_role;
grant select, insert, update, delete on public.cart_items to service_role;
grant select, insert, update, delete on public.shared_carts to service_role;
grant select, insert, update, delete on public.wishlists to service_role;
grant select, insert, update, delete on public.wishlist_items to service_role;

notify pgrst, 'reload schema';

commit;
