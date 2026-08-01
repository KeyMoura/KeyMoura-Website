begin;

alter table public.orders
  add column if not exists final_review_note text,
  add column if not exists final_review_asset_paths text[] not null default '{}';

drop policy if exists "staff upload order review assets" on storage.objects;
create policy "staff upload order review assets" on storage.objects for insert to authenticated
with check (bucket_id = 'order-assets' and (select public.is_staff_user()));

drop policy if exists "staff delete order review assets" on storage.objects;
create policy "staff delete order review assets" on storage.objects for delete to authenticated
using (bucket_id = 'order-assets' and (select public.is_staff_user()));

notify pgrst, 'reload schema';
commit;
