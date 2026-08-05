import "server-only";
import { Resend } from "resend";
import { routeServiceClient } from "@/lib/api/routeAuth";

export type CommerceEmailTemplateKey =
  | "request_received" | "staff_new_request" | "needs_information" | "quote_ready"
  | "status_update" | "customer_message" | "staff_message" | "payment_received"
  | "order_shipped" | "order_delivered"
  // Lifecycle templates, seeded by `20260805010000`. A key with no row still
  // sends: `sendCommerceEmail` falls back to a generic subject and body rather
  // than dropping the message, so a missed seed degrades to a plain email
  // instead of silence.
  | "order_cancelled" | "cancellation_requested" | "cancellation_approved" | "cancellation_denied"
  | "refund_initiated" | "refund_completed" | "refund_failed"
  | "return_requested" | "return_approved" | "return_denied" | "return_received" | "return_inspected";

const defaults = {
  enabled: true, fromName: "KeyMoura", fromEmail: "orders@keymoura.com", replyTo: "support@keymoura.com",
  staffNotificationEmail: "", sendCustomerMessages: true, sendStatusUpdates: true, sendPaymentUpdates: true,
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"})[c]!);
const interpolate = (text: string, vars: Record<string,string>) => text.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => vars[key] ?? "");

export async function getCommerceEmailConfig() {
  const { data } = await routeServiceClient.from("site_settings").select("site_name,public_url,logo_url,primary_color,accent_color,email_config").eq("singleton", true).maybeSingle();
  return { ...defaults, ...((data?.email_config ?? {}) as Partial<typeof defaults>), siteName: data?.site_name || "KeyMoura", siteUrl: String(data?.public_url || process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, ""), logoUrl: data?.logo_url || "", primaryColor: data?.primary_color || "#dc2626", accentColor: data?.accent_color || "#f59e0b" };
}

export async function sendCommerceEmail(input: { to?: string | null; orderId?: string | null; templateKey: CommerceEmailTemplateKey; eventKey: string; variables: Record<string,string>; href?: string; }) {
  const config = await getCommerceEmailConfig();
  const { data: template } = await routeServiceClient.from("email_templates").select("subject,heading,body,button_label,is_enabled").eq("key", input.templateKey).maybeSingle();
  const recipient = input.to?.trim() || "";
  const subject = interpolate(template?.subject || "KeyMoura order update", input.variables);
  const log = async (status: "sent"|"failed"|"skipped", providerId?: string, error?: string) => routeServiceClient.from("email_deliveries").upsert({ order_id: input.orderId || null, template_key: input.templateKey, recipient: recipient || "not configured", subject, status, provider_id: providerId || null, error_message: error?.slice(0,1000) || null, event_key: input.eventKey }, { onConflict: "event_key", ignoreDuplicates: true });
  if (!config.enabled || template?.is_enabled === false || !recipient) { await log("skipped", undefined, !recipient ? "Recipient not configured" : "Email disabled"); return { sent:false as const }; }
  if (!process.env.RESEND_API_KEY) { await log("skipped", undefined, "RESEND_API_KEY is not configured"); return { sent:false as const }; }
  const url = input.href?.startsWith("http") ? input.href : `${config.siteUrl}${input.href || (input.orderId ? `/orders/${input.orderId}` : "/")}`;
  const heading = interpolate(template?.heading || "Order update", input.variables);
  const body = interpolate(template?.body || "There is an update to your order.", input.variables);
  const button = interpolate(template?.button_label || "View order", input.variables);
  const logo = config.logoUrl ? `<img src="${escapeHtml(config.logoUrl.startsWith("http") ? config.logoUrl : config.siteUrl + config.logoUrl)}" alt="${escapeHtml(config.siteName)}" style="max-height:42px;max-width:180px;margin-bottom:24px"/>` : `<div style="font-weight:700;margin-bottom:24px">${escapeHtml(config.siteName)}</div>`;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({ from: `${config.fromName} <${config.fromEmail}>`, to: recipient, replyTo: config.replyTo || undefined, subject, html: `<div style="background:#0b0b0c;padding:36px 16px;color:#f4f4f5;font-family:Arial,sans-serif"><div style="max-width:580px;margin:auto;background:#151517;border:1px solid #333;border-radius:16px;padding:32px">${logo}<div style="color:${escapeHtml(config.accentColor)};font-size:12px;letter-spacing:.16em;text-transform:uppercase">${escapeHtml(input.variables.order_label || "KeyMoura")}</div><h1 style="font-size:26px;line-height:1.2;margin:12px 0">${escapeHtml(heading)}</h1><p style="color:#d4d4d8;line-height:1.65;white-space:pre-line">${escapeHtml(body)}</p><a href="${escapeHtml(url)}" style="display:inline-block;margin-top:18px;background:${escapeHtml(config.primaryColor)};border-radius:10px;padding:12px 18px;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(button)}</a></div></div>` }, { idempotencyKey: input.eventKey });
    if (error) { await log("failed", undefined, error.message); return { sent:false as const }; }
    await log("sent", data?.id); return { sent:true as const };
  } catch (error) { await log("failed", undefined, error instanceof Error ? error.message : "Unknown provider error"); return { sent:false as const }; }
}
