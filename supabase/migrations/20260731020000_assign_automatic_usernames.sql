begin;

create or replace function public.ensure_user_profile(p_user_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  auth_user auth.users%rowtype;
  candidate text;
  base_username text;
  suffix integer := 1;
begin
  select * into auth_user from auth.users where id = p_user_id;
  if not found then
    return;
  end if;

  candidate := coalesce(
    nullif(auth_user.raw_user_meta_data->>'preferred_username', ''),
    nullif(auth_user.raw_user_meta_data->>'user_name', ''),
    nullif(auth_user.raw_user_meta_data->>'full_name', ''),
    nullif(auth_user.raw_user_meta_data->>'name', ''),
    nullif(split_part(coalesce(auth_user.email, ''), '@', 1), ''),
    'user'
  );
  base_username := trim(both '_' from regexp_replace(lower(candidate), '[^a-z0-9]+', '_', 'g'));
  base_username := left(coalesce(nullif(base_username, ''), 'user'), 24);

  insert into public.profiles(
    id,
    username,
    display_name,
    avatar_url
  )
  values(
    auth_user.id,
    null,
    coalesce(
      nullif(auth_user.raw_user_meta_data->>'full_name', ''),
      nullif(auth_user.raw_user_meta_data->>'name', '')
    ),
    coalesce(
      nullif(auth_user.raw_user_meta_data->>'avatar_url', ''),
      nullif(auth_user.raw_user_meta_data->>'picture', '')
    )
  )
  on conflict(id) do update set
    display_name = coalesce(public.profiles.display_name, excluded.display_name),
    avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  if exists(select 1 from public.profiles where id = p_user_id and username is not null) then
    return;
  end if;

  loop
    candidate := case
      when suffix = 1 then base_username
      else left(base_username, greatest(1, 24 - length(suffix::text))) || suffix::text
    end;
    begin
      update public.profiles
      set username = candidate
      where id = p_user_id and username is null;
      exit;
    exception when unique_violation then
      suffix := suffix + 1;
    end;
  end loop;
end $$;
revoke all on function public.ensure_user_profile(uuid) from public, anon, authenticated;
grant execute on function public.ensure_user_profile(uuid) to service_role;

create or replace function public.create_profile_for_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.ensure_user_profile(new.id);
  return new;
end $$;
revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;

do $$ begin
  if not exists(select 1 from pg_trigger where tgname='auth_user_create_profile' and not tgisinternal) then
    create trigger auth_user_create_profile after insert on auth.users
      for each row execute function public.create_profile_for_auth_user();
  end if;
end $$;

do $$ declare existing_user record;
begin
  for existing_user in select id from auth.users loop
    perform public.ensure_user_profile(existing_user.id);
  end loop;
end $$;

notify pgrst, 'reload schema';

commit;
