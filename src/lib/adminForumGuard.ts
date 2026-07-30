import { isUserAdmitted } from "@/lib/accountAdmission";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const anonClient = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false },
});

export const serviceClient = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

export async function requireAdminLike(accessToken: string) {
  const { data: u, error: uErr } = await anonClient.auth.getUser(accessToken);
  if (uErr || !u.user || !(await isUserAdmitted(u.user.id))) return { ok: false as const, status: 401, error: "Unauthorized" };

  const actorUserId = u.user.id;

  // Permission-based staff gate (no role checks). We still return actorRole for logging only.
  const { data: roleRow, error: roleErr } = await serviceClient
    .from("user_roles")
    .select("role")
    .eq("user_id", actorUserId)
    .maybeSingle<{ role: string }>();

  const role = !roleErr && roleRow?.role ? roleRow.role : "member";

  const staffViewPerms = [
    "security.view",
    "community.view",
    "analytics.view",
    "audit.view",
    "shops.view",
    "info.pending.view",
    "info.updates.view",
  ];

  const { data: rolePermRow } = await serviceClient
    .from("role_permissions")
    .select("permissions")
    .eq("role", role)
    .maybeSingle<{ permissions: string[] | null }>();

  const { data: userPermRow } = await serviceClient
    .from("user_permissions")
    .select("permissions")
    .eq("user_id", actorUserId)
    .maybeSingle<{ permissions: string[] | null }>();

  const all = new Set<string>([
    ...((rolePermRow?.permissions ?? []) as string[]),
    ...((userPermRow?.permissions ?? []) as string[]),
  ]);

  const allowed = staffViewPerms.some((p) => all.has(p));
  if (!allowed) return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, actorUserId, actorRole: role };
}

export function getBearerToken(authHeader: string | null) {
  if (!authHeader) return null;
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}
