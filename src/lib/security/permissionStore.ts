import "server-only";

import { createClient } from "@supabase/supabase-js";
import { PERMISSIONS, permissionsForRole, type PermissionKey } from "@/lib/permissions";
import { normalizeRole } from "@/lib/roles";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

export type PermissionStoreResult = {
  role: string;
  permissions: ReadonlySet<PermissionKey>;
  source: "db" | "fallback";
};

type RolePermissionRow = {
  permission_key: string;
};

type UserPermissionRow = {
  permission_key: string;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function createPlaceholderClient() {
  return createClient("http://localhost", "invalid", { auth: { persistSession: false } });
}

const serviceClient = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
  : createPlaceholderClient();

function asPermissionKey(value: unknown): PermissionKey | null {
  if (!isString(value)) return null;
  const normalized = value;
  const k = normalized as PermissionKey;
  return (PERMISSIONS as readonly string[]).includes(normalized) ? k : null;
}

function toPermissionSet(values: unknown): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  if (!isArray(values)) return out;
  for (const v of values) {
    if (isRecord(v)) {
      const k = asPermissionKey(v.permission_key);
      if (k) out.add(k);
    }
  }
  return out;
}

export async function loadPermissionsForUser(params: {
  userId: string;
  role: unknown;
}): Promise<PermissionStoreResult> {
  const role = normalizeRole(params.role);

  /**
   * IMPORTANT: Permission model is DB-first.
   *
   * - role_permissions and user_permissions are the source of truth.
   * - Code defaults are ONLY used as a safety fallback when the DB has no
   *   mapping rows yet (for the current role AND user).
   *
   * This ensures "Support can see X" never happens due to hardcoded role
   * defaults.
   */
  const fallbackBase = permissionsForRole(role);

  try {
    const [rolePerms, userPerms, profileRes, perksRes] = await Promise.all([
      serviceClient
        .from("role_permissions")
        .select("permission_key")
        .eq("role_key", role)
        .returns<RolePermissionRow[]>(),
      serviceClient
        .from("user_permissions")
        .select("permission_key")
        .eq("user_id", params.userId)
        .returns<UserPermissionRow[]>(),
      serviceClient
        .from("profiles")
        .select("is_verified")
        .eq("id", params.userId)
        .maybeSingle<{ is_verified: boolean | null }>(),
      serviceClient
        .from("site_verified_perks")
        .select("permissions")
        .eq("id", 1)
        .maybeSingle<{ permissions: unknown }>(),
    ]);

    const roleSet = toPermissionSet(rolePerms.data);
    const userSet = toPermissionSet(userPerms.data);

    const isVerified = Boolean((profileRes as any)?.data?.is_verified);

    const verifiedBonus = new Set<PermissionKey>();
    if (isVerified) {
      const raw = (perksRes as any)?.data?.permissions;
      if (isArray(raw)) {
        for (const v of raw) {
          const k = asPermissionKey(v);
          if (k) verifiedBonus.add(k);
        }
      }
    }

    const hasDbRows = Boolean((rolePerms.data?.length ?? 0) || (userPerms.data?.length ?? 0));

    // DB-first: if we have any mapping rows, do NOT inject code defaults.
    const merged = new Set<PermissionKey>(hasDbRows ? [] : fallbackBase);
    for (const p of roleSet) merged.add(p);
    for (const p of userSet) merged.add(p);
    for (const p of verifiedBonus) merged.add(p);

    return { role, permissions: merged, source: hasDbRows ? "db" : "fallback" };
  } catch {
  }

  return { role, permissions: fallbackBase, source: "fallback" };
}
