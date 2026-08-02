begin;

create or replace function public.accept_staff_order_proposal(
  p_order_id uuid,
  p_customer_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_order public.orders%rowtype;
  selected_product public.products%rowtype;
  reserved_quantity integer := 0;
begin
  select * into selected_order from public.orders
    where id = p_order_id and customer_id = p_customer_id
    for update;

  if not found or not selected_order.initiated_by_staff or selected_order.status <> 'requested' then
    return false;
  end if;

  if selected_order.product_id is not null then
    select * into selected_product from public.products
      where id = selected_order.product_id
      for update;

    if not found or selected_product.archived_at is not null
      or selected_product.availability_status = 'unavailable' then
      raise exception 'product_unavailable';
    end if;

    if selected_product.inventory_policy = 'track' then
      if selected_product.inventory_quantity < selected_order.quantity
        and not selected_product.continue_selling_when_out_of_stock then
        raise exception 'insufficient_inventory';
      end if;
      reserved_quantity := least(selected_product.inventory_quantity, selected_order.quantity);
      update public.products
        set inventory_quantity = inventory_quantity - reserved_quantity
        where id = selected_product.id;
    end if;
  end if;

  update public.orders set
    status = 'accepted',
    proposal_decided_at = now(),
    proposal_decline_reason = null,
    payment_status = 'unpaid',
    inventory_reserved_quantity = reserved_quantity
  where id = selected_order.id;

  return true;
end $$;

revoke all on function public.accept_staff_order_proposal(uuid,uuid) from public, anon, authenticated;
grant execute on function public.accept_staff_order_proposal(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
