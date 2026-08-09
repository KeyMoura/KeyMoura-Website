import "server-only";
import { Resend } from "resend";
import { routeServiceClient } from "@/lib/api/routeAuth";
import {
  audienceForTemplate,
  classifyEmailFailure,
  type EmailFailureCategory,
  type EmailTemplateKey,
} from "@/lib/comms/emailEvents";
import { customerOrderUrl } from "@/lib/commerce/orderUrls";

/**
 * The one transactional sender. There is deliberately no second template
 * system: every message this application sends comes through here, is rendered
 * from an `email_templates` row, and is recorded in `email_deliveries`.
 *
 * The catalogue of *which* events exist lives in `lib/comms/emailEvents.ts`.
 * This file is the mechanism.
 */
export type CommerceEmailTemplateKey = EmailTemplateKey;
export { classifyEmailFailure };
export type { EmailFailureCategory };

const defaults = {
  enabled: true, fromName: "KeyMoura", fromEmail: "orders@keymoura.com", replyTo: "support@keymoura.com",
  staffNotificationEmail: "", sendCustomerMessages: true, sendStatusUpdates: true, sendPaymentUpdates: true,
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]!);

/**
 * A value interpolated into a *header* may not carry a line break.
 *
 * `customer_name` comes from user metadata, which the customer controls. The
 * Resend client posts JSON so a bare newline would be encoded rather than
 * splitting a header — but the subject is the one interpolated string that does
 * not pass through `escapeHtml`, and relying on a transport detail to make that
 * safe is the kind of assumption that stops being true when the transport
 * changes.
 */
const headerSafe = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const interpolate = (text: string, vars: Record<string,string>) =>
  text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => vars[key] ?? "");

const interpolateHeader = (text: string, vars: Record<string,string>) =>
  headerSafe(text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => headerSafe(vars[key] ?? "")));

export async function getCommerceEmailConfig() {
  const { data } = await routeServiceClient.from("site_settings").select("site_name,public_url,logo_url,primary_color,accent_color,email_config").eq("singleton", true).maybeSingle();
  return { ...defaults, ...((data?.email_config ?? {}) as Partial<typeof defaults>), siteName: data?.site_name || "KeyMoura", siteUrl: String(data?.public_url || process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, ""), logoUrl: data?.logo_url || "", primaryColor: data?.primary_color || "#dc2626", accentColor: data?.accent_color || "#f59e0b" };
}

type ClaimOutcome =
  | { claimed: true; deliveryId: string | null }
  | { claimed: false; reason: "already_sent" | "in_flight" | "lost_race" };

/**
 * Claim the right to send this event, before sending it.
 *
 * The previous implementation sent first and recorded afterwards, so two
 * concurrent calls carrying the same event key **both sent** — the only thing
 * standing between a customer and two identical emails was Resend's own
 * `idempotencyKey`, which is a provider-side 24-hour window rather than a
 * durable guarantee, and which does not exist at all for a provider that is
 * swapped in later.
 *
 * The claim is a row insert against the unique `event_key`. Exactly one caller
 * wins; the loser reads what the winner recorded and decides:
 *
 *   * `sent` or `delivered` — the customer already has it. Never send again.
 *     This is the property the whole scheme exists for.
 *   * `queued` — somebody is sending it *right now*. Suppress rather than race.
 *   * `failed` or `skipped` — nothing reached the customer, so a retry is
 *     correct. The row is re-claimed with a guarded update and the attempt
 *     counter goes up, which is what makes "we tried four times" visible.
 */
async function claimDelivery(input: {
  eventKey: string;
  orderId: string | null;
  templateKey: string;
  recipient: string;
  subject: string;
  audience: string | null;
  resendOfId?: string | null;
  resentBy?: string | null;
}): Promise<ClaimOutcome> {
  const base = {
    order_id: input.orderId,
    template_key: input.templateKey,
    recipient: input.recipient || "not configured",
    subject: input.subject,
    status: "queued",
    event_key: input.eventKey,
    audience: input.audience,
    resend_of_id: input.resendOfId ?? null,
    resent_by: input.resentBy ?? null,
    updated_at: new Date().toISOString(),
  };

  const inserted = await routeServiceClient.from("email_deliveries").insert(base).select("id").maybeSingle();
  if (!inserted.error) return { claimed: true, deliveryId: inserted.data?.id ?? null };
  // 23505 is the unique violation on `event_key`. Anything else is a real
  // failure and must not be mistaken for "already sent".
  if (inserted.error.code !== "23505") return { claimed: false, reason: "lost_race" };

  const existing = await routeServiceClient
    .from("email_deliveries")
    .select("id,status,attempt_count")
    .eq("event_key", input.eventKey)
    .maybeSingle();
  const row = existing.data as { id: string; status: string; attempt_count: number | null } | null;
  if (!row) return { claimed: false, reason: "lost_race" };
  if (row.status === "sent" || row.status === "delivered") return { claimed: false, reason: "already_sent" };
  if (row.status === "queued") return { claimed: false, reason: "in_flight" };

  // Re-assert the status we read, so two retries racing each other produce one
  // attempt rather than two.
  const reclaimed = await routeServiceClient
    .from("email_deliveries")
    .update({
      status: "queued",
      attempt_count: (row.attempt_count ?? 1) + 1,
      subject: input.subject,
      recipient: input.recipient || "not configured",
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", row.status)
    .select("id")
    .maybeSingle();
  if (reclaimed.error || !reclaimed.data) return { claimed: false, reason: "lost_race" };
  return { claimed: true, deliveryId: row.id };
}

/**
 * A customer email the provider refused.
 *
 * Deliberately an in-app alert and **never itself an email**: emailing about a
 * broken mailer is how a failure loop starts, and the one case where the
 * mailer is definitely broken is the case that would trigger it.
 *
 * Only customer messages alert. A staff alert failing is worth recording in the
 * delivery history but is not worth a notification — the same information is
 * already reaching those people through the bell, which is the surface the
 * alert would land on.
 *
 * Imported lazily so `commerceEmail` keeps no import-time dependency on the
 * notification stack; a mailer that cannot be loaded without the notification
 * layer is a mailer that fails when the notification layer does.
 */
async function alertOnCustomerFailure(
  audience: string | null,
  templateKey: string,
  eventKey: string,
  category: EmailFailureCategory
) {
  if (audience !== "customer") return;
  try {
    const { raiseOperationalAlert } = await import("@/lib/comms/operationalAlerts");
    await raiseOperationalAlert({
      kind: "ops.email_failure",
      subjectId: eventKey,
      message: `A "${templateKey}" email to a customer was not delivered (${category.replace(/_/g, " ")}). Open the delivery history to re-send it.`,
    });
  } catch {
    // An alert about a failed email must not itself become a failure.
  }
}

async function finishDelivery(
  deliveryId: string | null,
  eventKey: string,
  status: "sent" | "failed" | "skipped",
  detail: { providerId?: string; error?: string; category?: EmailFailureCategory } = {}
) {
  const patch: Record<string, unknown> = {
    status,
    provider_id: detail.providerId ?? null,
    error_message: detail.error?.slice(0, 1000) ?? null,
    failure_category: status === "sent" ? null : detail.category ?? null,
    delivered_at: status === "sent" ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const query = routeServiceClient.from("email_deliveries").update(patch);
  await (deliveryId ? query.eq("id", deliveryId) : query.eq("event_key", eventKey));
}

export type SendCommerceEmailResult = {
  sent: boolean;
  /** True when nothing was sent because this event had already been handled. */
  suppressed?: boolean;
  category?: EmailFailureCategory;
};

export async function sendCommerceEmail(input: {
  to?: string | null;
  orderId?: string | null;
  templateKey: CommerceEmailTemplateKey;
  eventKey: string;
  variables: Record<string,string>;
  href?: string;
  /** Set only by the resend route: the delivery this repeats, and who asked. */
  resendOfId?: string | null;
  resentBy?: string | null;
}): Promise<SendCommerceEmailResult> {
  const config = await getCommerceEmailConfig();
  const { data: template } = await routeServiceClient.from("email_templates").select("subject,heading,body,button_label,is_enabled").eq("key", input.templateKey).maybeSingle();
  const recipient = input.to?.trim() || "";
  const subject = interpolateHeader(template?.subject || "KeyMoura order update", input.variables);
  const audience = audienceForTemplate(input.templateKey);

  const claim = await claimDelivery({
    eventKey: input.eventKey,
    orderId: input.orderId || null,
    templateKey: input.templateKey,
    recipient,
    subject,
    audience,
    resendOfId: input.resendOfId,
    resentBy: input.resentBy,
  });
  if (!claim.claimed) return { sent: false, suppressed: true };
  const deliveryId = claim.deliveryId;

  const stop = async (category: EmailFailureCategory, message: string) => {
    await finishDelivery(deliveryId, input.eventKey, "skipped", { error: message, category });
    return { sent: false as const, category };
  };

  if (!recipient) return stop("invalid_recipient", "Recipient not configured");
  if (!config.enabled || template?.is_enabled === false) return stop("disabled", "Email disabled");
  if (!process.env.RESEND_API_KEY) return stop("not_configured", "RESEND_API_KEY is not configured");

  /**
   * The link in the button, derived from ownership exactly once.
   *
   * Every customer email that names an order goes through here, so this is the
   * only place that has to know a guest order lives at `/orders/guest/<id>`.
   * Doing it at the call sites instead meant a dozen places each deciding, and
   * a guest reliably being sent to `/orders/<id>` — a page that reads through
   * RLS as a signed-in customer and can only ever show them a permission error
   * for their own order.
   *
   * Staff emails keep whatever explicit `href` they set: `/staff/orders/<id>`
   * is not an ownership question. The lookup is skipped when there is no order.
   */
  let url = input.href?.startsWith("http") ? input.href : `${config.siteUrl}${input.href || "/"}`;
  if (input.orderId && audience === "customer") {
    const ownership = await routeServiceClient
      .from("orders")
      .select("customer_id")
      .eq("id", input.orderId)
      .maybeSingle();
    url = customerOrderUrl(config.siteUrl, input.orderId, ownership.data?.customer_id as string | null | undefined);
  }
  const heading = interpolate(template?.heading || "Order update", input.variables);
  const body = interpolate(template?.body || "There is an update to your order.", input.variables);
  const button = interpolate(template?.button_label || "View order", input.variables);
  const logo = config.logoUrl ? `<img src="${escapeHtml(config.logoUrl.startsWith("http") ? config.logoUrl : config.siteUrl + config.logoUrl)}" alt="${escapeHtml(config.siteName)}" style="max-height:42px;max-width:180px;margin-bottom:24px"/>` : `<div style="font-weight:700;margin-bottom:24px">${escapeHtml(config.siteName)}</div>`;
  // A plain-text alternative on every message, not just the HTML one. Some
  // clients render only this part, spam filters weight its absence, and it is
  // what a screen reader in a text-first client actually reads. It is built
  // from the same interpolated strings, so the two versions cannot drift.
  const plainText = [
    config.siteName,
    input.variables.order_label ? `\n${input.variables.order_label}` : "",
    `\n${heading}`,
    `\n${body}`,
    `\n${button}: ${url}`,
    // The verification code goes in the *body* and nowhere else. Never appended
    // to `url`: a code in a link is a code in browser history, in the `Referer`
    // of the next click, and in any analytics that sees the path.
    input.variables.verification_code
      ? `\nVerification code: ${input.variables.verification_code}\nYou'll need this code to access your order.`
      : "",
  ].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim();

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const codeBlock = input.variables.verification_code
      ? `<div style="margin-top:24px;padding:18px;border:1px solid #52525b;border-radius:10px"><div style="color:#d4d4d8">Verification code:</div><div style="font-size:30px;font-weight:700;letter-spacing:.18em;margin-top:8px">${escapeHtml(input.variables.verification_code)}</div><div style="color:#d4d4d8;margin-top:10px">You&#39;ll need this code to access your order.</div></div>`
      : "";
    const { data, error } = await resend.emails.send({ from: `${config.fromName} <${config.fromEmail}>`, to: recipient, replyTo: config.replyTo || undefined, subject, text: plainText, html: `<div style="background:#0b0b0c;padding:36px 16px;color:#f4f4f5;font-family:Arial,sans-serif"><div style="max-width:580px;margin:auto;background:#151517;border:1px solid #333;border-radius:16px;padding:32px">${logo}<div style="color:${escapeHtml(config.accentColor)};font-size:12px;letter-spacing:.16em;text-transform:uppercase">${escapeHtml(input.variables.order_label || "KeyMoura")}</div><h1 style="font-size:26px;line-height:1.2;margin:12px 0">${escapeHtml(heading)}</h1><p style="color:#d4d4d8;line-height:1.65;white-space:pre-line">${escapeHtml(body)}</p><a href="${escapeHtml(url)}" style="display:inline-block;margin-top:18px;background:${escapeHtml(config.primaryColor)};border-radius:10px;padding:12px 18px;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(button)}</a>${codeBlock}</div></div>` }, { idempotencyKey: input.eventKey });
    if (error) {
      const category = classifyEmailFailure(error.message);
      await finishDelivery(deliveryId, input.eventKey, "failed", { error: error.message, category });
      await alertOnCustomerFailure(audience, input.templateKey, input.eventKey, category);
      return { sent: false, category };
    }
    await finishDelivery(deliveryId, input.eventKey, "sent", { providerId: data?.id });
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown provider error";
    const category = classifyEmailFailure(message);
    await finishDelivery(deliveryId, input.eventKey, "failed", { error: message, category });
    await alertOnCustomerFailure(audience, input.templateKey, input.eventKey, category);
    return { sent: false, category };
  }
}
