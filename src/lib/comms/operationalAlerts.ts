import "server-only";

import { createNotification } from "@/lib/notifications";
import { resolveStaffRecipients } from "@/lib/orderNotifications";
import { routeServiceClient } from "@/lib/api/routeAuth";
import {
  NOTIFICATION_ALERTS_BY_KIND,
  alertHref,
  notificationEventKey,
  previewMessage,
  resolutionEventKey,
  type NotificationAlertKind,
} from "./notificationEvents";

/**
 * The one way an operational alert reaches staff.
 *
 * There is deliberately no second notification system. Everything — a new
 * order, a failed refund, a broken webhook, a product running out — lands in
 * the bell staff already read, with the same shape, the same deduplication and
 * the same deep-linking rule.
 *
 * Three properties this module owns, so no caller has to remember them:
 *
 *   1. **Recipients come from a permission**, resolved through the same
 *      `resolveStaffRecipients` the order notifications use. Nobody is told
 *      about work they cannot do, and the actor is excluded — telling somebody
 *      about the thing they just did is noise.
 *   2. **The event key is durable**, so a retried route call, two tabs, or a
 *      webhook replay produce one notification rather than several.
 *   3. **Nothing free-form from a customer enters the payload.** The title
 *      comes from the catalogue, and the message is written by the caller for
 *      staff. A customer's message body, note or address never reaches here.
 */

export type OperationalAlertInput = {
  kind: NotificationAlertKind;
  /** The record the alert is about. Used for the key and the deep link. */
  subjectId: string;
  /**
   * Only where the same subject can legitimately raise the same kind again and
   * each occurrence is genuinely new — an inventory alert row id, for example.
   * Never a timestamp: that defeats the whole mechanism.
   */
  discriminator?: string | null;
  /** One or two sentences, written for staff. */
  message: string;
  /** Excluded from the recipients. */
  actorUserId?: string | null;
  /** Overrides the catalogue link when the subject is not what the reader should open. */
  href?: string;
};

export type OperationalAlertResult = {
  kind: NotificationAlertKind;
  eventKey: string;
  /** How many staff members received a *new* notification. */
  delivered: number;
  /** How many were suppressed because they already had this exact event. */
  suppressed: number;
};

async function fanOut(
  kind: NotificationAlertKind,
  eventKey: string,
  title: string,
  message: string,
  href: string,
  actorUserId: string | null,
  permissionKey: string
): Promise<OperationalAlertResult> {
  const recipients = await resolveStaffRecipients(permissionKey, actorUserId);
  const spec = NOTIFICATION_ALERTS_BY_KIND[kind];

  const results = await Promise.all(
    recipients.map((recipientUserId) =>
      createNotification({
        recipientUserId,
        actorUserId,
        type: "order",
        bypassBlock: true,
        eventKey,
        payload: {
          title,
          message: previewMessage(message),
          href,
          alert_kind: kind,
          priority: spec.priority,
        },
      })
    )
  );

  const delivered = results.filter((result) => result.created).length;
  return { kind, eventKey, delivered, suppressed: results.length - delivered };
}

/**
 * Raise an operational alert.
 *
 * Never throws: an alert failing must not undo the financial or fulfillment
 * action that produced it. That is the same rule `sendLifecycleNotification`
 * follows, and for the same reason — a customer's refund must not be rolled
 * back because a bell did not ring.
 */
export async function raiseOperationalAlert(input: OperationalAlertInput): Promise<OperationalAlertResult | null> {
  const spec = NOTIFICATION_ALERTS_BY_KIND[input.kind];
  if (!spec) return null;
  try {
    const eventKey = notificationEventKey(input.kind, input.subjectId, input.discriminator);
    return await fanOut(
      input.kind,
      eventKey,
      spec.title,
      input.message,
      input.href || alertHref(input.kind, input.subjectId),
      input.actorUserId ?? null,
      spec.permissionKey
    );
  } catch (error) {
    console.error("raiseOperationalAlert failed", { kind: input.kind, error: describe(error) });
    return null;
  }
}

/**
 * Announce that a resolvable condition has cleared.
 *
 * Only the kinds marked `resolvable` may do this. An alert that nobody ever
 * sees close teaches staff that the bell is a list of things that were once
 * true, which is how a real blocker gets scrolled past.
 */
export async function resolveOperationalAlert(input: OperationalAlertInput): Promise<OperationalAlertResult | null> {
  const spec = NOTIFICATION_ALERTS_BY_KIND[input.kind];
  if (!spec?.resolvable) return null;
  try {
    const eventKey = resolutionEventKey(input.kind, input.subjectId, input.discriminator);
    return await fanOut(
      input.kind,
      eventKey,
      `Resolved: ${spec.title.toLowerCase()}`,
      input.message,
      input.href || alertHref(input.kind, input.subjectId),
      input.actorUserId ?? null,
      spec.permissionKey
    );
  } catch (error) {
    console.error("resolveOperationalAlert failed", { kind: input.kind, error: describe(error) });
    return null;
  }
}

/**
 * Record that an integration actually worked, or actually did not.
 *
 * This is what lets the health page distinguish *verified* from *assumed*. An
 * environment variable being set proves configuration; only an observation
 * proves health, and the page says which of the two it is looking at.
 *
 * `summary` is written by the caller and must stay safe: never a provider
 * payload, never a secret, and never a Postgres `details` field — that is the
 * one that echoes row values back, and on this schema a row value can be an
 * address or a private note.
 */
export async function recordIntegrationObservation(input: {
  integrationKey: string;
  outcome: "success" | "failure";
  summary?: string;
}): Promise<void> {
  try {
    await routeServiceClient.from("integration_health_events").insert({
      integration_key: input.integrationKey.slice(0, 80),
      outcome: input.outcome,
      summary: input.summary?.slice(0, 300) ?? null,
    });
  } catch (error) {
    // Health bookkeeping must never take down the path it is observing.
    console.error("recordIntegrationObservation failed", { key: input.integrationKey, error: describe(error) });
  }
}

/** A message with no provider payload, no stack and no row values in it. */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "Unknown error";
}
