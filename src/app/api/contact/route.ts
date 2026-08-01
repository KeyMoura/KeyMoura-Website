import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { getCommerceEmailConfig } from "@/lib/commerceEmail";
import { getSiteSettings } from "@/lib/siteSettings";

const attempts = new Map<string, number[]>();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);

export async function POST(request: NextRequest) {
  const key = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 60 * 60 * 1000);
  if (recent.length >= 5) return NextResponse.json({ error: "Too many messages. Please try again later." }, { status: 429 });
  attempts.set(key, [...recent, now]);

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (clean(body.website, 200)) return NextResponse.json({ ok: true });
  const name = clean(body.name, 100), email = clean(body.email, 254), subject = clean(body.subject, 140), message = clean(body.message, 5000);
  if (!name || !emailPattern.test(email) || !subject || message.length < 10) return NextResponse.json({ error: "Enter your name, a valid email, a subject, and a message." }, { status: 400 });
  if (!process.env.RESEND_API_KEY) return NextResponse.json({ error: "Support email is temporarily unavailable. Please email us directly." }, { status: 503 });

  const [settings, emailConfig] = await Promise.all([getSiteSettings(), getCommerceEmailConfig()]);
  const recipient = emailConfig.staffNotificationEmail || settings.supportEmail;
  if (!recipient) return NextResponse.json({ error: "Support email is not configured." }, { status: 503 });
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: `${emailConfig.fromName} <${emailConfig.fromEmail}>`, to: recipient, replyTo: email,
    subject: `[Website] ${subject}`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h1>Website contact</h1><p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p><p><strong>Subject:</strong> ${escapeHtml(subject)}</p><p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>`,
  });
  if (error) return NextResponse.json({ error: "Could not send your message. Please try again." }, { status: 502 });
  return NextResponse.json({ ok: true });
}
