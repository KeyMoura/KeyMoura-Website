import type { SupabaseClient } from "@supabase/supabase-js";
import { routeServiceClient } from "@/lib/api/routeAuth";

export type StaffRole = "admin" | "moderator" | "support" | "member";

export async function getActorRole(userId: string, supabase: SupabaseClient = routeServiceClient): Promise<StaffRole> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle<{ role: string }>();

  const r = !error && data?.role ? String(data.role) : "member";
  if (r === "admin" || r === "moderator" || r === "support") return r;
  return "member";
}

export function canStaffModerate(role: StaffRole) {
  return role === "admin" || role === "moderator" || role === "support";
}

export function canPinThreads(role: StaffRole) {
  return role === "admin" || role === "moderator";
}
