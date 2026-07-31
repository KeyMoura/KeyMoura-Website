begin;

alter table public.site_settings
  add column if not exists theme_config jsonb not null default '{"background":"#0a0f10","backgroundEnd":"#050708","surface":"#111827","surfaceStrong":"#18181b","text":"#f4f4f5","mutedText":"#a1a1aa","border":"#3f3f46","radius":"rounded","density":"comfortable","font":"modern","buttonStyle":"solid"}'::jsonb;

insert into public.permissions(key, name, description) values
  ('appearance.manage', 'Manage appearance', 'Change the shared site colors, typography, spacing, and control styles')
on conflict(key) do update set name=excluded.name, description=excluded.description;

insert into public.role_permissions(role_key, permission_key)
values ('admin', 'appearance.manage')
on conflict do nothing;

grant select on public.site_settings to anon, authenticated;
grant select, update on public.site_settings to service_role;

notify pgrst, 'reload schema';
commit;
