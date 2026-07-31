begin;

alter table public.products
  add column if not exists model_url text,
  add column if not exists model_poster_url text;

create table if not exists public.product_media (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  kind text not null default 'image' check (kind in ('image', 'model')),
  url text not null,
  alt_text text,
  sort_order integer not null default 0
);

create table if not exists public.product_option_groups (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  option_key text not null check (option_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  input_type text not null default 'select' check (input_type in (
    'select', 'radio', 'text', 'textarea', 'number', 'checkbox', 'file'
  )),
  description text,
  placeholder text,
  is_required boolean not null default false,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (product_id, option_key)
);

create table if not exists public.product_option_values (
  id uuid primary key default gen_random_uuid(),
  option_group_id uuid not null references public.product_option_groups(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 100),
  value text not null check (char_length(btrim(value)) between 1 and 100),
  price_adjustment_cents integer not null default 0,
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  unique (option_group_id, value)
);

alter table public.product_option_groups
  add column if not exists updated_at timestamptz not null default now();

create index if not exists product_media_product_idx on public.product_media(product_id, sort_order);
create index if not exists product_option_groups_product_idx on public.product_option_groups(product_id, sort_order);
create index if not exists product_option_values_group_idx on public.product_option_values(option_group_id, sort_order);

drop trigger if exists product_option_groups_touch_updated_at on public.product_option_groups;
create trigger product_option_groups_touch_updated_at before update on public.product_option_groups
for each row execute function public.touch_commerce_updated_at();

alter table public.product_media enable row level security;
alter table public.product_option_groups enable row level security;
alter table public.product_option_values enable row level security;

drop policy if exists "published product media readable" on public.product_media;
create policy "published product media readable" on public.product_media for select to anon, authenticated
using (exists (select 1 from public.products p where p.id = product_id and p.is_published));
drop policy if exists "staff manage product media" on public.product_media;
create policy "staff manage product media" on public.product_media for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

drop policy if exists "published product options readable" on public.product_option_groups;
create policy "published product options readable" on public.product_option_groups for select to anon, authenticated
using (exists (select 1 from public.products p where p.id = product_id and p.is_published and p.is_custom));
drop policy if exists "staff manage product options" on public.product_option_groups;
create policy "staff manage product options" on public.product_option_groups for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

drop policy if exists "published product option values readable" on public.product_option_values;
create policy "published product option values readable" on public.product_option_values for select to anon, authenticated
using (exists (
  select 1 from public.product_option_groups g join public.products p on p.id = g.product_id
  where g.id = option_group_id and p.is_published and p.is_custom and is_active
));
drop policy if exists "staff manage product option values" on public.product_option_values;
create policy "staff manage product option values" on public.product_option_values for all to authenticated
using ((select public.is_staff_user())) with check ((select public.is_staff_user()));

grant select on public.product_media, public.product_option_groups, public.product_option_values to anon, authenticated;
grant insert, update, delete on public.product_media, public.product_option_groups, public.product_option_values to authenticated;
grant select, insert, update, delete on public.product_media, public.product_option_groups, public.product_option_values to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-assets', 'product-assets', true, 52428800, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/avif',
  'model/gltf-binary', 'model/gltf+json', 'application/octet-stream'
])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit)
values ('order-assets', 'order-assets', false, 20971520)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

drop policy if exists "staff upload product assets" on storage.objects;
create policy "staff upload product assets" on storage.objects for insert to authenticated
with check (bucket_id = 'product-assets' and (select public.is_staff_user()));
drop policy if exists "staff update product assets" on storage.objects;
create policy "staff update product assets" on storage.objects for update to authenticated
using (bucket_id = 'product-assets' and (select public.is_staff_user()))
with check (bucket_id = 'product-assets' and (select public.is_staff_user()));
drop policy if exists "staff delete product assets" on storage.objects;
create policy "staff delete product assets" on storage.objects for delete to authenticated
using (bucket_id = 'product-assets' and (select public.is_staff_user()));
drop policy if exists "public read product assets" on storage.objects;
create policy "public read product assets" on storage.objects for select to anon, authenticated
using (bucket_id = 'product-assets');

drop policy if exists "customers upload own order assets" on storage.objects;
create policy "customers upload own order assets" on storage.objects for insert to authenticated
with check (bucket_id = 'order-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "customers and staff read order assets" on storage.objects;
create policy "customers and staff read order assets" on storage.objects for select to authenticated
using (
  bucket_id = 'order-assets' and
  ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_staff_user()))
);
drop policy if exists "customers delete own order assets" on storage.objects;
create policy "customers delete own order assets" on storage.objects for delete to authenticated
using (bucket_id = 'order-assets' and (storage.foldername(name))[1] = (select auth.uid())::text);

notify pgrst, 'reload schema';
commit;
