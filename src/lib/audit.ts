// src/lib/audit.ts
import { headers } from "next/headers";
import { describeAction } from "@/lib/audit/actions";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import { isRetainedAuditEvent } from "@/lib/audit/retention";

/**
 * The original audit entry point, kept for its ~115 existing call sites.
 *
 * It no longer writes to the table itself. It normalizes its arguments and
 * hands them to `recordAuditEvent`, so every event — legacy or canonical —
 * lands in one shape with an actor label, an entity type and a change set.
 * New instrumentation should call `recordAuditEvent` directly; this exists so
 * the moderation, approvals and community routes did not all have to be
 * rewritten to gain the new columns.
 */

export type AuditEvent = {
  actorUserId?: string | null;
  actorRole?: string | null; // 'admin' | 'user' | 'system' | etc
  eventType: string;         // 'garage.create', 'admin.ban_user', 'order.status_changed', etc
  targetTable?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Fire-and-forget audit logger.
 *
 * Errors are reported by `recordAuditEvent` (logged with SQLSTATE) and the
 * boolean result is returned here so a caller that cares can check it. The
 * historical callers ignore it, which is why this remains non-throwing.
 */
export async function logAuditEvent(event: AuditEvent): Promise<boolean> {
  try {
    // The retention rule lives in `@/lib/audit/retention` so it can be tested
    // against the event names the codebase actually uses.
    if (!isRetainedAuditEvent(event.eventType, event.actorRole)) return false;

    // `headers()` is typed as returning a Promise here, so it is awaited before
    // `.get`. It throws outside a request scope, which is why the whole body is
    // wrapped — a background caller must not crash on a missing request.
    let ip: string | null = null;
    try {
      const requestHeaders = await headers();
      const forwardedFor = requestHeaders.get("x-forwarded-for");
      ip = forwardedFor?.split(",")[0]?.trim() ?? requestHeaders.get("x-real-ip") ?? null;
    } catch {
      ip = null;
    }

    const definition = describeAction(event.eventType);
    const actorLabel = event.actorUserId ? await resolveActorLabel(event.actorUserId) : null;

    const result = await recordAuditEvent({
      action: event.eventType,
      actor: event.actorUserId
        ? { kind: "staff", userId: event.actorUserId, role: event.actorRole ?? null, label: actorLabel }
        : { kind: "system" },
      entity: {
        type: definition.entityType,
        id: event.targetId ?? null,
      },
      // The legacy callers put ids in metadata under a dozen different names.
      // Only the two unambiguous ones are promoted to relationship columns;
      // guessing the rest would produce links that quietly point at the wrong
      // record, which is worse than no link.
      related: {
        orderId: event.targetTable === "orders" ? toUuid(event.targetId) : null,
        productionJobId: event.targetTable === "production_jobs" ? toUuid(event.targetId) : null,
      },
      metadata: event.metadata ?? {},
      actorIp: ip,
      source: "api",
    });

    return result.ok;
  } catch (err) {
    // Never break the main request.
    // eslint-disable-next-line no-console
    console.error("Failed to log audit event", err);
    return false;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The relationship columns are `uuid`; a non-uuid target id is not one. */
function toUuid(value: string | null | undefined): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}
