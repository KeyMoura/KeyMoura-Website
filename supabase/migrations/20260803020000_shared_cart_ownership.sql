-- Lets the creator of a shared cart revoke it.
--
-- Additive.
--
-- `shared_carts` already carries `created_by`, which is null for a guest. That
-- makes a guest's own share link unrevocable by its creator, so the feature
-- would ship with a permanent public artifact nobody can withdraw.
--
-- `owner_hash` is a salted digest of `user:<id>` or `guest:<token>`, computed by
-- the application. Hashing rather than storing the guest token directly matters:
-- that token is a bearer credential for a live cart, and a shared_carts row is
-- exactly the kind of record that gets read while debugging a public page.
-- One column covers both owner kinds, so listing and revoking is a single code
-- path rather than two that can drift apart.

begin;

alter table public.shared_carts
  add column if not exists owner_hash text,
  add column if not exists snapshot_subtotal_cents integer;

create index if not exists shared_carts_owner_hash_idx
  on public.shared_carts (owner_hash, created_at desc)
  where owner_hash is not null;

-- Viewing a live share link bumps its counter. Written as a function so the
-- public page never needs update rights on the table itself.
create or replace function public.touch_shared_cart(p_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.shared_carts
  set view_count = view_count + 1
  where token = p_token and revoked_at is null;
$$;

revoke all on function public.touch_shared_cart(text) from public, anon, authenticated;
grant execute on function public.touch_shared_cart(text) to service_role;

notify pgrst, 'reload schema';

commit;
