import { routeServiceClient } from "@/lib/api/routeAuth";

export type StaffRateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAtIso: string;
  warning: boolean;
};

type Role = "admin" | "moderator" | "support" | string;

function getDefaultLimit(role: Role): { limit: number; windowMinutes: number } {
  const r = (role ?? "").toLowerCase();
  if (r === "admin") return { limit: 20, windowMinutes: 10 };
  if (r === "moderator") return { limit: 10, windowMinutes: 10 };
  if (r === "support") return { limit: 5, windowMinutes: 10 };
  return { limit: 3, windowMinutes: 10 };
}

export async function checkStaffRateLimit(args: {
  actorUserId: string;
  actorRole: Role;
  eventTypes: string[];
  overrideLimit?: number;
  overrideWindowMinutes?: number;
}): Promise<StaffRateLimitResult> {
  const { actorUserId, actorRole, eventTypes } = args;
  const defaults = getDefaultLimit(actorRole);
  const limit = typeof args.overrideLimit === "number" ? args.overrideLimit : defaults.limit;
  const windowMinutes =
    typeof args.overrideWindowMinutes === "number" ? args.overrideWindowMinutes : defaults.windowMinutes;

  const now = Date.now();
  const windowStartMs = now - windowMinutes * 60 * 1000;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const resetAtIso = new Date(windowStartMs + windowMinutes * 60 * 1000).toISOString();

  if (!eventTypes.length) {
    return { ok: true, limit, remaining: limit, resetAtIso, warning: false };
  }

  const { count, error } = await routeServiceClient
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", actorUserId)
    .gte("created_at", windowStartIso)
    .in("event_type", eventTypes);

  if (error) {
    // Fail open: do not block moderation actions if audit table/query fails.
    return { ok: true, limit, remaining: limit, resetAtIso, warning: false };
  }

  const used = typeof count === "number" ? count : 0;
  const remaining = Math.max(0, limit - used);
  const warning = remaining <= Math.max(1, Math.floor(limit * 0.2));

  return { ok: remaining > 0, limit, remaining, resetAtIso, warning };
}
