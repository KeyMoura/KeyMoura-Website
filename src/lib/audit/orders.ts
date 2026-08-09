import "server-only";

import { buildChangeSet, isEmptyChangeSet } from "./diff.ts";
import { recordAuditEvent, resolveActorLabel, type AuditSource } from "./events.ts";
import { ORDER_AUDIT_FIELDS, ORDER_NOTED_WITHOUT_CONTENT, resolveOrderAction } from "./orderRules.ts";

export { ORDER_AUDIT_FIELDS, resolveOrderAction } from "./orderRules.ts";

/**
 * Order auditing, in one place so every route that edits an order describes the
 * change the same way.
 *
 * The field list is the point. An order row carries the customer's address,
 * internal staff notes and the wording sent to a customer at final review; none
 * of those belong in a table read by everyone with `audit.view`. What is
 * recorded is the state that decides money, timing and where the goods go.
 */

export type OrderAuditInput = {
  orderId: string;
  /** The row as it was before the write. */
  before: Record<string, unknown>;
  /** The row as it is after — or the patch that was applied. */
  after: Record<string, unknown>;
  actorUserId: string | null;
  actorRole?: string | null;
  orderNumber?: string | null;
  source?: AuditSource;
  actorIp?: string | null;
  correlationId?: string | null;
  /** Overrides the derived action, for routes that know better. */
  action?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Records one order edit, or nothing at all when nothing changed.
 *
 * Returns `false` when the audit write failed so the caller can surface it —
 * the mutation has already committed by this point, and reporting a clean
 * success for an unlogged change is the failure mode this return value exists
 * to prevent.
 */
export async function recordOrderAudit(input: OrderAuditInput): Promise<boolean | null> {
  const changes = buildChangeSet(input.before, input.after, ORDER_AUDIT_FIELDS);

  const alsoChanged = ORDER_NOTED_WITHOUT_CONTENT.filter((field) => {
    if (!(field in input.after)) return false;
    const before = input.before[field];
    const after = input.after[field];
    return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
  });

  // A save that moved nothing audited and touched no note is not an event.
  if (isEmptyChangeSet(changes) && alsoChanged.length === 0) return null;

  const label = input.orderNumber?.trim() || `Order ${input.orderId.slice(0, 8)}`;

  const result = await recordAuditEvent({
    action: input.action ?? resolveOrderAction(changes),
    actor: input.actorUserId
      ? {
          kind: "staff",
          userId: input.actorUserId,
          role: input.actorRole ?? null,
          label: await resolveActorLabel(input.actorUserId),
        }
      : { kind: "system" },
    entity: { type: "order", id: input.orderId, label },
    related: { orderId: input.orderId },
    changes,
    metadata: {
      ...(input.metadata ?? {}),
      ...(alsoChanged.length ? { also_changed: alsoChanged } : {}),
    },
    correlationId: input.correlationId ?? null,
    source: input.source ?? "api",
    actorIp: input.actorIp ?? null,
  });

  return result.ok;
}
