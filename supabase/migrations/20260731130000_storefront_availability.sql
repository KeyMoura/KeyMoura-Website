begin;

alter table public.products
  add column if not exists availability_status text not null default 'made_to_order',
  add column if not exists lead_time_text text;

do $$ begin
  alter table public.products add constraint products_availability_status_check
    check (availability_status in ('available', 'limited', 'made_to_order', 'unavailable'));
exception when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
commit;
