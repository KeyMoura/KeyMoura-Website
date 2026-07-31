begin;

alter table public.orders
  add column if not exists checkout_token uuid,
  add column if not exists inventory_reserved_quantity integer not null default 0
    check (inventory_reserved_quantity >= 0);

create unique index if not exists orders_customer_checkout_token_idx
  on public.orders(customer_id, checkout_token) where checkout_token is not null;

create or replace function public.create_checkout_order(
  p_customer_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_specifications jsonb,
  p_customer_notes text,
  p_target_date date,
  p_fulfillment_method text,
  p_shipping_address jsonb,
  p_checkout_token uuid
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  selected_product public.products%rowtype;
  existing_order_id uuid;
  created_order_id uuid;
  reserved_quantity integer := 0;
begin
  select id into existing_order_id from public.orders
    where customer_id = p_customer_id and checkout_token = p_checkout_token;
  if existing_order_id is not null then return existing_order_id; end if;
  if p_quantity < 1 or p_quantity > 1000 then raise exception 'invalid_quantity'; end if;
  if p_fulfillment_method not in ('shipping','pickup') then raise exception 'invalid_fulfillment'; end if;
  if p_fulfillment_method = 'shipping' and p_shipping_address is null then raise exception 'shipping_address_required'; end if;

  select * into selected_product from public.products where id = p_product_id for update;
  if not found or not selected_product.is_published or selected_product.archived_at is not null
    or selected_product.availability_status = 'unavailable' then raise exception 'product_unavailable'; end if;

  select id into existing_order_id from public.orders
    where customer_id = p_customer_id and checkout_token = p_checkout_token;
  if existing_order_id is not null then return existing_order_id; end if;

  if selected_product.inventory_policy = 'track' then
    if selected_product.inventory_quantity < p_quantity and not selected_product.continue_selling_when_out_of_stock then
      raise exception 'insufficient_inventory';
    end if;
    reserved_quantity := least(selected_product.inventory_quantity, p_quantity);
    update public.products set inventory_quantity = inventory_quantity - reserved_quantity where id = selected_product.id;
  end if;

  insert into public.orders (
    customer_id, product_id, product_name, quantity, specifications, customer_notes, target_date,
    fulfillment_method, shipping_address, checkout_token, inventory_reserved_quantity
  ) values (
    p_customer_id, selected_product.id, selected_product.name, p_quantity, coalesce(p_specifications, '{}'::jsonb),
    nullif(btrim(p_customer_notes), ''), p_target_date, p_fulfillment_method,
    case when p_fulfillment_method = 'shipping' then p_shipping_address else null end,
    p_checkout_token, reserved_quantity
  ) returning id into created_order_id;
  return created_order_id;
end $$;

revoke all on function public.create_checkout_order(uuid,uuid,integer,jsonb,text,date,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.create_checkout_order(uuid,uuid,integer,jsonb,text,date,text,jsonb,uuid) to service_role;

create or replace function public.release_checkout_inventory()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.inventory_reserved_quantity > 0 and new.status in ('declined','cancelled','completed') and old.status not in ('declined','cancelled','completed') then
    if new.status in ('declined','cancelled') and old.product_id is not null then
      update public.products set inventory_quantity = inventory_quantity + old.inventory_reserved_quantity where id = old.product_id;
    end if;
    new.inventory_reserved_quantity := 0;
  end if;
  return new;
end $$;

drop trigger if exists orders_release_checkout_inventory on public.orders;
create trigger orders_release_checkout_inventory before update of status on public.orders
for each row execute function public.release_checkout_inventory();
revoke all on function public.release_checkout_inventory() from public, anon, authenticated;

create or replace function public.restore_deleted_checkout_inventory()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if old.inventory_reserved_quantity > 0 and old.product_id is not null then
    update public.products set inventory_quantity = inventory_quantity + old.inventory_reserved_quantity where id = old.product_id;
  end if;
  return old;
end $$;

drop trigger if exists orders_restore_deleted_checkout_inventory on public.orders;
create trigger orders_restore_deleted_checkout_inventory before delete on public.orders
for each row execute function public.restore_deleted_checkout_inventory();
revoke all on function public.restore_deleted_checkout_inventory() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
