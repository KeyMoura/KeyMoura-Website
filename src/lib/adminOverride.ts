import { routeServiceClient } from "@/lib/api/routeAuth";

/**
 * Verify the admin override password stored (hashed) in site_security_settings.
 *
 * Requires these SQL functions:
 * - public.verify_admin_override_password(p_password text) returns boolean
 */
export async function verifyAdminOverridePassword(password: string): Promise<boolean> {
  const trimmed = password.trim();
  if (!trimmed) return false;

  const { data, error } = await routeServiceClient.rpc(
    "verify_admin_override_password",
    { p_password: trimmed }
  );

  if (error) {
    // eslint-disable-next-line no-console
    console.error("verify_admin_override_password rpc error", error);
    return false;
  }

  return data === true;
}
