-- A trigger function is not an API endpoint.
--
-- `20260809102004` added `product_option_value_media_belongs_to_product()` as a
-- SECURITY DEFINER trigger function. PostgREST exposes every function in the
-- `public` schema as `/rest/v1/rpc/<name>`, so Supabase's security linter
-- immediately — and correctly — reported it as callable by `anon` and by
-- `authenticated`.
--
-- Calling it outside a trigger would fail anyway, because `new` is unbound. But
-- "it happens to error" is not an access control, and the grant itself is the
-- finding. Revoking from PUBLIC as well as from the two roles is what makes it
-- stick: role grants inherit from PUBLIC, so revoking only `anon` and
-- `authenticated` would leave the privilege in place through the default.
--
-- SECURITY DEFINER is kept deliberately. The check has to see the option group
-- and the media row regardless of who is writing; as SECURITY INVOKER, RLS could
-- hide the media row from the caller and the trigger would refuse a link that is
-- perfectly valid. Verified after applying: the trigger still fires and still
-- refuses a cross-product image with 23514, while `has_function_privilege` is
-- false for both roles.
--
-- This is a grant change only. No table, column, policy or data is touched.

revoke all on function public.product_option_value_media_belongs_to_product() from public;
revoke all on function public.product_option_value_media_belongs_to_product() from anon;
revoke all on function public.product_option_value_media_belongs_to_product() from authenticated;
