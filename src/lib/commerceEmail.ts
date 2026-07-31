import "server-only";
import { Resend } from "resend";

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]!);
}

export async function sendOrderEmail(input: {
  to: string | null | undefined;
  orderId: string;
  orderNumber: string | null;
  productName: string;
  subject: string;
  message: string;
  eventKey: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !input.to) return { sent: false, reason: "not_configured" as const };

  const resend = new Resend(apiKey);
  const label = input.orderNumber || "your request";
  const url = `${siteUrl}/orders/${input.orderId}`;
  const { error } = await resend.emails.send({
    from: process.env.ORDER_EMAIL_FROM || "KeyMoura <orders@keymoura.com>",
    to: input.to,
    subject: input.subject,
    html: `<div style="background:#111;color:#f4f4f5;font-family:Arial,sans-serif;padding:32px"><div style="max-width:560px;margin:auto"><div style="color:#f5a623;font-size:12px;letter-spacing:.18em;text-transform:uppercase">KeyMoura · ${escapeHtml(label)}</div><h1 style="font-size:24px">${escapeHtml(input.productName)}</h1><p style="color:#d4d4d8;line-height:1.6">${escapeHtml(input.message)}</p><a href="${url}" style="display:inline-block;margin-top:14px;border:1px solid #f5a623;border-radius:10px;padding:12px 18px;color:#f5a623;text-decoration:none">View order</a></div></div>`,
  }, { idempotencyKey: input.eventKey });

  if (error) {
    console.error("Order email failed", error);
    return { sent: false, reason: "provider_error" as const };
  }
  return { sent: true as const };
}
