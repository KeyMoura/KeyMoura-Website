import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { sendCommerceEmail, type CommerceEmailTemplateKey } from "@/lib/commerceEmail";
import { resendEventKey, toDeliveryView, type DeliveryRow } from "@/lib/comms/deliveryCenter";
import { maskRecipient } from "@/lib/comms/emailEvents";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";

/**
 * Re-send one transactional email to the person it was originally addressed to.
 *
 * This is deliberately **not** a composer. There is no recipient field, no
 * subject field and no body field anywhere in the request: the address comes
 * from the stored delivery, the wording comes from the same `email_templates`
 * row the original used, and the only thing the caller supplies is *which
 * delivery* and the state they saw when they decided.
 *
 * That constraint is the whole design. A resend control that accepts a
 * recipient is an open relay behind a staff permission; one that accepts a body
 * is a way to send arbitrary mail from the shop's verified domain. Neither is
 * something this feature needs in order to fix "the customer never got their
 * return instructions".
 *
 * ## What makes a second click harmless
 *
 * The resend's event key is derived from the *original* delivery's key plus the
 * attempt number, so two clicks in the same moment compute the same key and the
 * second is refused by `email_deliveries_event_key_key`. The customer gets one
 * copy. A genuinely later resend — made after the first was seen to fail — has
 * a higher attempt number and is a real new event, which is correct: that is a
 * person deciding again, not a browser retrying.
 *
 * ## What stays immutable
 *
 * The original row is never updated. A resend is a new row carrying
 * `resend_of_id`, so the history reads "sent, failed, re-sent by X on Y" rather
 * than a single row that quietly changed its mind about what happened.
 */

type ResendBody = {
  /** The status the page rendered from. A mismatch means the page is stale. */
  expectedStatus?: unknown;
  /** How many resends the page already knew about. Guards the same way. */
  expectedResendCount?: unknown;
};

const SELECT =
  "id,order_id,template_key,recipient,subject,status,failure_category,audience,attempt_count,delivered_at,resend_of_id,event_key,created_at,updated_at";

/** Preview: what would be sent, to whom, under which template. No side effect. */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAnyPermission(req, ["emails.view", "emails.resend"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;

  const loaded = await loadDelivery(id);
  if ("error" in loaded) return loaded.error;
  const { row, resendCount, templateName, orderNumber } = loaded;

  const view = toDeliveryView(row, {
    orderNumbers: orderNumber && row.order_id ? { [row.order_id]: orderNumber } : {},
    templateNames: row.template_key ? { [row.template_key]: templateName } : {},
  });

  return NextResponse.json({
    preview: {
      deliveryId: view.id,
      templateKey: view.templateKey,
      templateName: view.templateName,
      subject: view.subject,
      maskedRecipient: view.maskedRecipient,
      orderNumber: view.orderNumber,
      audience: view.audience,
      status: view.status,
      createdAt: view.createdAt,
      resendCount,
      canResend: view.canResend && actor.permissions.has("emails.resend"),
      blockedReason: view.canResend
        ? actor.permissions.has("emails.resend")
          ? null
          : "Re-sending needs the Re-send transactional email permission."
        : view.resendBlockedReason,
    },
  });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  // Read is not enough. Causing an email to leave the building is its own
  // permission and is granted to no non-admin role by default.
  const actor = await requirePermission(req, "emails.resend");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;

  const body = ((await req.json().catch(() => null)) ?? {}) as ResendBody;

  const loaded = await loadDelivery(id);
  if ("error" in loaded) return loaded.error;
  const { row, resendCount, templateName } = loaded;

  const view = toDeliveryView(row, {});
  if (!view.canResend) {
    return NextResponse.json({ error: view.resendBlockedReason ?? "This message cannot be re-sent." }, { status: 409 });
  }

  // Stale-page guards. Both are compared against what the client rendered from,
  // so a resend decided on one screen cannot be applied to a different reality.
  if (typeof body.expectedStatus === "string" && body.expectedStatus !== row.status) {
    return NextResponse.json(
      {
        error: `This record now reads "${row.status}", not "${body.expectedStatus}". Reload before re-sending.`,
        currentStatus: row.status,
      },
      { status: 409 }
    );
  }
  if (typeof body.expectedResendCount === "number" && body.expectedResendCount !== resendCount) {
    return NextResponse.json(
      {
        error:
          resendCount > (body.expectedResendCount as number)
            ? "Somebody has already re-sent this message. Reload to see the result before sending another."
            : "This record has changed since the page loaded. Reload before re-sending.",
        currentResendCount: resendCount,
      },
      { status: 409 }
    );
  }

  if (!row.template_key || !row.event_key) {
    return NextResponse.json({ error: "This record is missing the details needed to re-send it." }, { status: 409 });
  }

  const eventKey = resendEventKey(row.event_key, resendCount + 1);

  // Audited before the send, so an attempt that fails at the provider is still
  // recorded as having been made. An audit trail that only holds successes
  // cannot answer "who tried to email this customer".
  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.email.resend",
    targetTable: "email_deliveries",
    targetId: row.id,
    // Deliberately no recipient, no subject and no body: the audit log is read
    // more widely and kept longer than the delivery centre.
    metadata: { template_key: row.template_key, order_id: row.order_id, attempt: resendCount + 1 },
  });

  const result = await sendCommerceEmail({
    to: row.recipient,
    orderId: row.order_id,
    templateKey: row.template_key as CommerceEmailTemplateKey,
    eventKey,
    resendOfId: row.id,
    resentBy: actor.userId,
    // The same variables the template renders from. `detail` is empty because a
    // resend adds nothing to the message — it is the same message again.
    variables: await resendVariables(row),
    href: row.order_id ? `/orders/${row.order_id}` : undefined,
  });

  if (result.suppressed) {
    return NextResponse.json(
      { error: "That re-send was already in progress. Reload to see the result.", suppressed: true },
      { status: 409 }
    );
  }

  if (!result.sent) {
    await raiseOperationalAlert({
      kind: "ops.email_failure",
      subjectId: row.id,
      discriminator: String(resendCount + 1),
      actorUserId: actor.userId,
      message: `A re-send of "${templateName}" was refused by the email provider.`,
    });
    return NextResponse.json(
      {
        error: "The email provider refused the message. Nothing was delivered; the failure is recorded in the history.",
        category: result.category ?? "unknown",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    maskedRecipient: maskRecipient(row.recipient),
    resendCount: resendCount + 1,
  });
}

type Loaded = {
  row: DeliveryRow & { event_key: string | null };
  resendCount: number;
  templateName: string;
  orderNumber: string | null;
};

async function loadDelivery(id: string): Promise<Loaded | { error: NextResponse }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const { data, error } = await routeServiceClient.from("email_deliveries").select(SELECT).eq("id", id).maybeSingle();
  if (error) {
    console.error("resend load failed", { code: error.code, hint: error.hint });
    return { error: NextResponse.json({ error: "That record could not be read." }, { status: 502 }) };
  }
  if (!data) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };

  const row = data as DeliveryRow & { event_key: string | null };

  // A resend of a resend still counts against the *original*, so the attempt
  // number is monotonic no matter which row in the chain a staff member is
  // looking at.
  const rootId = row.resend_of_id ?? row.id;
  const [{ count }, template, order] = await Promise.all([
    routeServiceClient
      .from("email_deliveries")
      .select("id", { count: "exact", head: true })
      .eq("resend_of_id", rootId),
    row.template_key
      ? routeServiceClient.from("email_templates").select("name").eq("key", row.template_key).maybeSingle()
      : Promise.resolve({ data: null }),
    row.order_id
      ? routeServiceClient.from("orders").select("order_number").eq("id", row.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    row,
    resendCount: count ?? 0,
    templateName: (template.data as { name?: string } | null)?.name ?? row.template_key ?? "Unknown",
    orderNumber: (order.data as { order_number?: string } | null)?.order_number ?? null,
  };
}

/**
 * The variables the re-sent message renders with.
 *
 * Rebuilt from the order rather than stored on the delivery, so a resend shows
 * the customer today's product name and order number rather than a stale copy —
 * and so nothing that was not customer-safe at send time can be resurrected. No
 * internal note, staff note or fulfillment note is read here, and a test
 * asserts those column names never appear in this file.
 */
async function resendVariables(row: DeliveryRow): Promise<Record<string, string>> {
  const fallback = {
    customer_name: "Customer",
    product_name: "your order",
    order_label: "your KeyMoura order",
    status: "",
    price: "",
    detail: "",
  };
  if (!row.order_id) return fallback;

  const { data } = await routeServiceClient
    .from("orders")
    .select("product_name,order_number,customer_id,agreed_price_cents")
    .eq("id", row.order_id)
    .maybeSingle();
  if (!data) return fallback;

  const order = data as {
    product_name?: string;
    order_number?: string;
    customer_id?: string;
    agreed_price_cents?: number | null;
  };

  let customerName = "Customer";
  if (order.customer_id) {
    const { data: authUser } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
    customerName =
      authUser.user?.user_metadata?.display_name || authUser.user?.email?.split("@")[0] || "Customer";
  }

  return {
    customer_name: customerName,
    product_name: order.product_name || "your order",
    order_label: order.order_number || "your KeyMoura order",
    status: "",
    price: typeof order.agreed_price_cents === "number" ? `$${(order.agreed_price_cents / 100).toFixed(2)}` : "",
    detail: "",
  };
}
