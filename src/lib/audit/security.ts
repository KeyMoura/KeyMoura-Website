import "server-only";

import type { ActorAccess } from "@/lib/permissions";
import { recordAuditEventStrict, resolveActorLabel } from "./events.ts";

/**
 * Security auditing helpers.
 *
 * Every write here is strict: role and permission changes are the ones an audit
 * log exists for, so a failure to record is reported rather than shrugged off.
 *
 * All three of the permission surfaces in this app — role→permission,
 * user→permission and the permission catalogue itself — replace a whole set on
 * save. Recording the resulting set is close to useless six months later;
 * "granted refunds.issue" is the readable fact, and it exists only as the
 * difference against the previous set.
 */

export type PermissionSetChange = {
  granted: string[];
  revoked: string[];
  beforeCount: number;
  afterCount: number;
};

/** The difference between two permission sets, sorted for a stable record. */
export function diffPermissionSets(
  before: readonly string[],
  after: readonly string[]
): PermissionSetChange {
  const previous = new Set(before);
  const next = new Set(after);
  return {
    granted: [...next].filter((key) => !previous.has(key)).sort(),
    revoked: [...previous].filter((key) => !next.has(key)).sort(),
    beforeCount: previous.size,
    afterCount: next.size,
  };
}

export type PermissionAuditInput = {
  actor: ActorAccess;
  action: "permission.changed" | "role.assigned" | "role.removed";
  entityType: "role" | "user";
  entityId: string;
  entityLabel: string;
  change: PermissionSetChange;
  actorIp?: string | null;
};

/**
 * Records a permission-set change, or nothing when the save was a no-op.
 *
 * Returns whether an event was written, so a caller can tell "nothing changed"
 * apart from "something changed".
 */
export async function recordPermissionSetChange(input: PermissionAuditInput): Promise<boolean> {
  const { granted, revoked, beforeCount, afterCount } = input.change;
  if (!granted.length && !revoked.length) return false;

  const summary = [
    granted.length ? `Granted ${granted.length}` : null,
    revoked.length ? `Revoked ${revoked.length}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  await recordAuditEventStrict({
    action: input.action,
    actor: {
      kind: "staff",
      userId: input.actor.userId,
      role: input.actor.role,
      label: await resolveActorLabel(input.actor.userId),
    },
    entity: { type: input.entityType, id: input.entityId, label: input.entityLabel },
    changes: {
      permissions: {
        before: beforeCount ? `${beforeCount} permissions` : "None",
        after: afterCount ? `${afterCount} permissions` : "None",
      },
    },
    summary: summary || null,
    // The keys themselves, so "who gave themselves refunds.issue" is answerable
    // from the detail view. Permission keys are not secrets.
    metadata: { granted, revoked },
    source: "staff_ui",
    actorIp: input.actorIp ?? null,
  });

  return true;
}

/** The first forwarded client address, or null. */
export function requestIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headers.get("x-real-ip")?.trim() ?? null;
}
