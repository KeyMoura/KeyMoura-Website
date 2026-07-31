-- Additive compatibility repair for partially installed KeyMoura databases.

alter table if exists public.info_search_events
  add column if not exists source text,
  add column if not exists raw_query text,
  add column if not exists tokens text[],
  add column if not exists results_count integer,
  add column if not exists top_result_id uuid,
  add column if not exists top_result_slug text,
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table if exists public.info_search_click_events
  add column if not exists source text,
  add column if not exists raw_query text,
  add column if not exists tokens text[],
  add column if not exists clicked_page_slug text,
  add column if not exists results_count integer,
  add column if not exists meta jsonb not null default '{}'::jsonb;

alter table if exists public.reports
  add column if not exists category text,
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_by uuid references auth.users(id) on delete set null;

grant select, insert on public.info_search_events, public.info_search_click_events to authenticated;
grant insert on public.info_search_events, public.info_search_click_events to anon;
grant select on public.reports to authenticated;

-- Keep legacy storage/table names for existing data, while the application exposes
-- the feature as Workshop. These columns provide project-oriented metadata without
-- deleting any older records.
alter table if exists public.garage_cars
  add column if not exists project_category text,
  add column if not exists materials text,
  add column if not exists tools_used text,
  add column if not exists process_notes text;

grant select on public.garage_cars, public.garage_car_likes to anon, authenticated;
grant insert, update, delete on public.garage_cars, public.garage_car_likes to authenticated;
