-- Saved Appearance templates.
--
-- Additive only: creates one new table plus its index and grants. It does not
-- read, alter, or delete any existing relation or row.
--
-- Templates live in their own table rather than inside site_settings because
-- that singleton row is loaded on every page render; an unbounded list of theme
-- snapshots inside it would grow the hot path without limit.

begin;

create table if not exists public.site_appearance_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_appearance_templates_name_length check (char_length(btrim(name)) between 1 and 60)
);

-- Names are unique case-insensitively so "Winter" and "winter" cannot both
-- exist and leave staff guessing which one they are applying.
create unique index if not exists site_appearance_templates_name_key
  on public.site_appearance_templates (lower(btrim(name)));

create index if not exists site_appearance_templates_updated_at_idx
  on public.site_appearance_templates (updated_at desc);

alter table public.site_appearance_templates enable row level security;

-- No anon or authenticated policy is defined on purpose. Every read and write
-- goes through /api/staff/appearance/templates, which authenticates the caller
-- and requires appearance.manage before using the service role.
revoke all on public.site_appearance_templates from anon, authenticated;
grant select, insert, update, delete on public.site_appearance_templates to service_role;

notify pgrst, 'reload schema';

commit;
