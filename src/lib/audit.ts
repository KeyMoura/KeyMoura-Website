// src/lib/audit.ts
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type AuditEvent = {
  actorUserId?: string | null;
  actorRole?: string | null; // 'admin' | 'user' | 'system' | etc
  eventType: string;         // 'garage.create', 'garage.update', 'admin.ban_user', etc
  targetTable?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Fire-and-forget audit logger.
 * Safe to call inside API routes; errors are swallowed and only logged to console.
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  try {
    // This project only retains audit logs for staff/admin actions.
    // Avoid logging high-volume user activity (posts, edits, blocks, etc.).
    const role = (event.actorRole ?? "").toLowerCase();
    const type = (event.eventType ?? "").toLowerCase();
    const isStaffActor = role === "admin" || role === "support" || role === "moderator";
    const isAdminEvent =
      type.startsWith("admin.") ||
      type.startsWith("security.") ||
      type.startsWith("approvals.") ||
      type.startsWith("moderation.") ||
      // Staff commerce actions (categories, catalog, discounts, order money)
      // are audited regardless of which staff role performed them. Without
      // this prefix a non-admin staff member's category and pricing changes
      // were silently dropped instead of recorded.
      type.startsWith("staff.");

    if (!isStaffActor && !isAdminEvent) return;

    // In your type setup, headers() is typed as returning a Promise<ReadonlyHeaders>
    // so we await it to satisfy TS, then use .get on the resulting Headers.
    const h = await headers();

    const forwardedFor = h.get("x-forwarded-for");
    const realIp = h.get("x-real-ip");

    const ip =
      forwardedFor?.split(",")[0]?.trim() ??
      realIp ??
      null;

    // supabaseAdmin is an already-created client instance (not a function)
    await supabaseAdmin.from("audit_logs").insert({
      actor_user_id: event.actorUserId ?? null,
      actor_role: event.actorRole ?? null,
      actor_ip: ip,
      event_type: event.eventType,
      target_table: event.targetTable ?? null,
      target_id: event.targetId ?? null,
      metadata: event.metadata ?? {},
    });
  } catch (err) {
    // Don't break the main request if logging fails
    // eslint-disable-next-line no-console
    console.error("Failed to log audit event", err);
  }
}
