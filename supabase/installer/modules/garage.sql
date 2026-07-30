begin;
create table if not exists public.garage_cars (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text, make text not null check (length(trim(make)) > 0), model text not null check (length(trim(model)) > 0),
  year integer check (year between 1900 and 2100), chassis text, trim text, color text, engine text,
  power_hp integer check (power_hp is null or power_hp >= 0), torque_ftlb integer check (torque_ftlb is null or torque_ftlb >= 0),
  weight_lb integer check (weight_lb is null or weight_lb > 0), use_type text not null default 'street',
  visibility text not null default 'public' check (visibility in ('public','unlisted','private')),
  is_primary boolean not null default false, summary text, mods text, cover_image_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists garage_one_primary_per_owner on public.garage_cars(owner_id) where is_primary;
create index if not exists garage_public_order_idx on public.garage_cars(visibility,is_primary desc,created_at desc);
create index if not exists garage_owner_idx on public.garage_cars(owner_id,updated_at desc);
create table if not exists public.garage_car_likes (car_id uuid references public.garage_cars(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, created_at timestamptz not null default now(), primary key(car_id,user_id));
create index if not exists garage_likes_user_idx on public.garage_car_likes(user_id,created_at desc);
alter table public.garage_cars enable row level security; alter table public.garage_car_likes enable row level security;
do $$ begin
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage visible read') then create policy "garage visible read" on public.garage_cars for select to anon,authenticated using(visibility='public' or owner_id=auth.uid()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner insert') then create policy "garage owner insert" on public.garage_cars for insert to authenticated with check(owner_id=auth.uid()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner update') then create policy "garage owner update" on public.garage_cars for update to authenticated using(owner_id=auth.uid()) with check(owner_id=auth.uid()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='garage owner delete') then create policy "garage owner delete" on public.garage_cars for delete to authenticated using(owner_id=auth.uid()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='garage likes read') then create policy "garage likes read" on public.garage_car_likes for select to anon,authenticated using(true); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='garage likes own') then create policy "garage likes own" on public.garage_car_likes for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_cars' and policyname='account_admission_required') then create policy account_admission_required on public.garage_cars as restrictive for all to authenticated using(public.is_account_admitted()) with check(public.is_account_admitted()); end if;
if not exists(select 1 from pg_policies where schemaname='public' and tablename='garage_car_likes' and policyname='account_admission_required') then create policy account_admission_required on public.garage_car_likes as restrictive for all to authenticated using(public.is_account_admitted()) with check(public.is_account_admitted()); end if;
end $$;
grant select on public.garage_cars,public.garage_car_likes to anon,authenticated; grant insert,update,delete on public.garage_cars,public.garage_car_likes to authenticated;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('garage-covers','garage-covers',true,10485760,array['image/jpeg','image/png','image/webp']) on conflict(id) do nothing;
do $$ begin if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='garage covers owner upload') then create policy "garage covers owner upload" on storage.objects for insert to authenticated with check(bucket_id='garage-covers' and (storage.foldername(name))[1]=auth.uid()::text); end if; end $$;
insert into public.schema_versions(module_key,version,checksum) values('garage',1,'installer-garage-v2') on conflict do nothing;
commit;
