import "server-only";

import { NextRequest } from "next/server";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { PERMISSIONS, type ActorAccess, type PermissionKey } from "../permissions";
import { loadPermissionsForUser } from "@/lib/security/permissionStore";
import { isUserAdmitted } from "@/lib/accountAdmission";

/**
 * Shared route authorization utilities.
 *
 * Client-side requests must respect RLS. Staff bypass is only allowed in server routes using
 * the service role key, and only after validating the caller's JWT and permissions.
 *
 * IMPORTANT:
 * - This module must not crash the entire runtime at import-time. If env vars are missing,
 *   requests are treated as unauthenticated and server routes should fail closed.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let cachedAnonClient: SupabaseClient | null = null;
let cachedServiceClient: SupabaseClient | null = null;

function createPlaceholderClient(): SupabaseClient {
  return createClient("http://localhost", "invalid", { auth: { persistSession: false } });
}

function getAnonClient(): SupabaseClient {
  if (cachedAnonClient) return cachedAnonClient;
  if (!supabaseUrl || !supabaseAnonKey) {
    cachedAnonClient = createPlaceholderClient();
    return cachedAnonClient;
  }
  cachedAnonClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });
  return cachedAnonClient;
}

function getServiceClient(): SupabaseClient {
  if (cachedServiceClient) return cachedServiceClient;
  if (!supabaseUrl || !serviceRoleKey) {
    cachedServiceClient = createPlaceholderClient();
    return cachedServiceClient;
  }
  cachedServiceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return cachedServiceClient;
}

/**
 * Returns the Bearer token from an Authorization header.
 */
function getBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token.length ? token : null;
}

/**
 * Reads the authenticated user from the request JWT.
 */
export async function getUserFromRequest(req: NextRequest): Promise<User | null> {
  const token = getBearerToken(req);

  // 1) Prefer explicit Bearer auth (used by some client fetches and external tooling)
  if (token) {
    try {
      const {
        data: { user },
      } = await getAnonClient().auth.getUser(token);
      return user && await isUserAdmitted(user.id) ? user : null;
    } catch {
      // fall through to cookie-based auth
    }
  }

  // 2) Fallback to cookie-based auth (normal browser requests)
  try {
    if (!supabaseUrl || !supabaseAnonKey) return null;

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        // Route handlers can't mutate the incoming request cookies; we still need to provide
        // a setter for the API, but it can be a no-op for reads.
        setAll: () => {
          /* no-op */
        },
      },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();

    return user && await isUserAdmitted(user.id) ? user : null;
  } catch {
    return null;
  }
}

/**
 * Loads the normalized role for a user.
 */
export async function getUserRole(userId: string): Promise<string> {
  if (!userId) return "member";

  try {
    const { data, error } = await getServiceClient()
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return "member";
    return data?.role ?? "member";
  } catch {
    return "member";
  }
}

/**
 * Returns true if the given user ID is an admin.
 */
export async function isAdminUserId(userId: string): Promise<boolean> {
  const role = await getUserRole(userId);
  return role === "admin";
}

/**
 * Requires any authenticated user.
 */
export async function requireUser(req: NextRequest): Promise<User | null> {
  return (await getUserFromRequest(req)) ?? null;
}

/**
 * Requires an authenticated admin.
 */
export async function requireAdmin(req: NextRequest): Promise<User | null> {
  const user = await getUserFromRequest(req);
  if (!user) return null;
  return (await isAdminUserId(user.id)) ? user : null;
}

/**
 * Loads an actor access model for permission checks.
 */
export async function getActorAccessFromRequest(req: NextRequest): Promise<ActorAccess | null> {
  const user = await getUserFromRequest(req);
  if (!user) return null;

  const role = await getUserRole(user.id);
  const { permissions } = await loadPermissionsForUser({ userId: user.id, role });

  let isOp = false;
  try {
    const { data } = await getServiceClient()
      .from("profiles")
      .select("is_op")
      .eq("id", user.id)
      .maybeSingle();
    isOp = Boolean((data as { is_op?: boolean } | null)?.is_op);
  } catch {
    isOp = false;
  }

  const effectivePermissions = isOp ? new Set(PERMISSIONS) : permissions;

  return {
    userId: user.id,
    role,
    permissions: effectivePermissions,
    isOp,
  };
}

/**
 * Returns true when the request actor has the given permission.
 */
export async function requestHasPermission(req: NextRequest, permission: PermissionKey): Promise<boolean> {
  const actor = await getActorAccessFromRequest(req);
  return actor ? actor.permissions.has(permission) : false;
}

/**
 * Requires an authenticated actor with a specific permission.
 */
export async function requirePermission(req: NextRequest, permission: PermissionKey): Promise<ActorAccess | null> {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return null;
  return actor.permissions.has(permission) ? actor : null;
}

/**
 * Requires an authenticated actor with at least one of the provided permissions.
 */
export async function requireAnyPermission(
  req: NextRequest,
  permissions: readonly PermissionKey[]
): Promise<ActorAccess | null> {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return null;
  for (const p of permissions) {
    if (actor.permissions.has(p)) return actor;
  }
  return null;
}

/**
 * A service-role Supabase client for server routes.
 */
export const routeServiceClient: SupabaseClient = getServiceClient();
