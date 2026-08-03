begin;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (status in (
  'requested','needs_information','accepted','awaiting_payment','in_progress',
  'customer_review','final_review','ready','completed','declined','cancelled'
));

commit;
