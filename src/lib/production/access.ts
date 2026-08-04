import "server-only";

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import { isUserAdmitted } from "@/lib/accountAdmission";
import { PERMISSIONS, type ActorAccess } from "@/lib/permissions";
import { loadPermissionsForUser } from "@/lib/security/permissionStore";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Actor resolution for server-rendered staff pages.
 *
 * `routeAuth.getActorAccessFromRequest` needs a `NextRequest`, which a React
 * Server Component does not have. This is the same decision made from the
 * cookie store instead: same admission check, same permission store, same
 * operator override — so a page and its API agree about who the caller is.
 *
 * Only the printable documents need this today. It is separate from
 * `routeAuth` rather than added to it because that module is imported by every
 * API route and pulls in `NextRequest`; this one is imported by pages.
 */
export async function getServerActorAccess(): Promise<ActorAccess | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !anonKey) return null;

  try {
    const cookieStore = await cookies();

    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        // A Server Component cannot write cookies. Reading is all this needs.
        setAll: () => {
          /* no-op */
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return null;
    if (!(await isUserAdmitted(user.id))) return null;

    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle<{ role: string | null }>();

    const role = roleRow?.role ?? "member";
    const { permissions } = await loadPermissionsForUser({ userId: user.id, role });

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("is_op")
      .eq("id", user.id)
      .maybeSingle<{ is_op: boolean | null }>();

    const isOp = Boolean(profile?.is_op);

    return {
      userId: user.id,
      role,
      permissions: isOp ? new Set(PERMISSIONS) : permissions,
      isOp,
    };
  } catch {
    // Fail closed. An unreadable session is not a staff session.
    return null;
  }
}
