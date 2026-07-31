-- Workshop galleries and discussion. Additive and safe to rerun.
create table if not exists public.workshop_project_images (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.garage_cars(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  image_url text not null,
  storage_path text,
  alt_text text,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now()
);
create index if not exists workshop_images_project_order_idx on public.workshop_project_images(project_id, sort_order, created_at);

create table if not exists public.workshop_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.garage_cars(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workshop_comments_project_created_idx on public.workshop_comments(project_id, created_at);

alter table public.workshop_project_images enable row level security;
alter table public.workshop_comments enable row level security;

do $$ begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_project_images' and policyname='workshop images visible') then
    create policy "workshop images visible" on public.workshop_project_images for select to anon, authenticated
      using (exists(select 1 from public.garage_cars p where p.id=project_id and (p.visibility='public' or p.owner_id=(select auth.uid()))));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_project_images' and policyname='workshop images owner insert') then
    create policy "workshop images owner insert" on public.workshop_project_images for insert to authenticated
      with check (owner_id=(select auth.uid()) and exists(select 1 from public.garage_cars p where p.id=project_id and p.owner_id=(select auth.uid())));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_project_images' and policyname='workshop images owner update') then
    create policy "workshop images owner update" on public.workshop_project_images for update to authenticated
      using(owner_id=(select auth.uid())) with check(owner_id=(select auth.uid()));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_project_images' and policyname='workshop images owner delete') then
    create policy "workshop images owner delete" on public.workshop_project_images for delete to authenticated using(owner_id=(select auth.uid()));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_comments' and policyname='workshop comments visible') then
    create policy "workshop comments visible" on public.workshop_comments for select to anon, authenticated
      using (exists(select 1 from public.garage_cars p where p.id=project_id and (p.visibility='public' or p.owner_id=(select auth.uid()))));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_comments' and policyname='workshop comments author insert') then
    create policy "workshop comments author insert" on public.workshop_comments for insert to authenticated
      with check(author_id=(select auth.uid()) and exists(select 1 from public.garage_cars p where p.id=project_id and p.visibility='public'));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_comments' and policyname='workshop comments author update') then
    create policy "workshop comments author update" on public.workshop_comments for update to authenticated
      using(author_id=(select auth.uid())) with check(author_id=(select auth.uid()));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_comments' and policyname='workshop comments delete') then
    create policy "workshop comments delete" on public.workshop_comments for delete to authenticated
      using(author_id=(select auth.uid()) or exists(select 1 from public.garage_cars p where p.id=project_id and p.owner_id=(select auth.uid())));
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_project_images' and policyname='account_admission_required') then
    create policy account_admission_required on public.workshop_project_images as restrictive for all to authenticated
      using(public.is_account_admitted()) with check(public.is_account_admitted());
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='workshop_comments' and policyname='account_admission_required') then
    create policy account_admission_required on public.workshop_comments as restrictive for all to authenticated
      using(public.is_account_admitted()) with check(public.is_account_admitted());
  end if;
end $$;

grant select on public.workshop_project_images, public.workshop_comments to anon, authenticated;
grant insert, update, delete on public.workshop_project_images, public.workshop_comments to authenticated;

-- Existing public bucket is retained for backwards compatibility; add owner cleanup rights.
do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='workshop images owner delete') then
    create policy "workshop images owner delete" on storage.objects for delete to authenticated
      using(bucket_id='garage-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
  end if;
end $$;
