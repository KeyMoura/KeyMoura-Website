alter table public.forum_categories
  add column if not exists parent_id bigint references public.forum_categories(id) on delete set null;

create index if not exists forum_categories_parent_id_idx
  on public.forum_categories(parent_id);

alter table public.forum_threads
  add column if not exists tags text[] default '{}'::text[];

create index if not exists forum_threads_tags_gin
  on public.forum_threads using gin (tags);
