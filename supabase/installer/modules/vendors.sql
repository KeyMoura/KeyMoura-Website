begin;
create table if not exists public.shops (
 id uuid primary key default gen_random_uuid(), slug text unique, name text not null check(length(trim(name))>=2), url text not null,
 description text, tags text[], featured boolean not null default false, sort_order integer not null default 0,
 is_published boolean not null default false, trust_status text not null default 'unknown' check(trust_status in ('trusted','untrusted','unknown')),
 warning_text text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists shops_slug_lower_idx on public.shops(lower(slug)) where slug is not null;
create index if not exists shops_public_order_idx on public.shops(is_published,featured desc,sort_order,created_at desc);
create index if not exists shops_tags_idx on public.shops using gin(tags);
alter table public.shops enable row level security;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='shops' and policyname='published shops read') then create policy "published shops read" on public.shops for select to anon,authenticated using(is_published); end if;
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='shops' and policyname='staff shops manage') then create policy "staff shops manage" on public.shops for all to authenticated using(exists(select 1 from public.user_roles ur where ur.user_id=auth.uid() and ur.role in ('admin','moderator'))) with check(exists(select 1 from public.user_roles ur where ur.user_id=auth.uid() and ur.role in ('admin','moderator'))); end if;
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='shops' and policyname='account_admission_required') then create policy account_admission_required on public.shops as restrictive for all to authenticated using(public.is_account_admitted()) with check(public.is_account_admitted()); end if;
end $$;
grant select on public.shops to anon,authenticated; grant insert,update,delete on public.shops to authenticated;
insert into public.schema_versions(module_key,version,checksum) values('vendors',1,'installer-vendors-v2') on conflict do nothing;
commit;
