begin;

alter table public.site_settings
  add column if not exists branding_config jsonb not null default '{"shortName":"KeyMoura","tagline":"Built around your idea.","wordmarkUrl":"","footerLogoUrl":"/brand/keymoura-colored.png","faviconUrl":"/favicon.ico","appleIconUrl":"/apple-icon.png","supportEmail":"support@keymoura.com","copyrightText":"All rights reserved."}'::jsonb;

comment on column public.site_settings.branding_config is
  'Validated site identity assets and display copy managed by staff Appearance settings.';

notify pgrst, 'reload schema';
commit;
