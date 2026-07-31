begin;

alter table public.orders
  add column if not exists fulfillment_method text not null default 'shipping'
    check (fulfillment_method in ('shipping','pickup')),
  add column if not exists shipping_address jsonb,
  add column if not exists shipping_carrier text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

alter table public.orders drop constraint if exists orders_tracking_details_check;
alter table public.orders add constraint orders_tracking_details_check check (
  fulfillment_method = 'pickup'
  or tracking_number is null
  or nullif(btrim(coalesce(shipping_carrier, '')), '') is not null
);

insert into public.email_templates(key,name,subject,heading,body,button_label) values
  ('order_shipped','Order shipped','{{order_label}} has shipped','Your order is on the way','Your {{product_name}} order has shipped with {{carrier}}. Tracking number: {{tracking_number}}.','Track shipment'),
  ('order_delivered','Order delivered','{{order_label}} was delivered','Your order was delivered','Your {{product_name}} order was marked delivered. Thank you for choosing KeyMoura.','View order')
on conflict (key) do nothing;

notify pgrst, 'reload schema';
commit;
