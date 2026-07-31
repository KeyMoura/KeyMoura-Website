import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { getCommerceEmailConfig } from "@/lib/commerceEmail";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0,max) : "";
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "emails.manage");
  if (!actor) return NextResponse.json({ error:"Forbidden" }, { status:403 });
  const [{ data: templates, error }, config] = await Promise.all([
    routeServiceClient.from("email_templates").select("key,name,subject,heading,body,button_label,is_enabled,updated_at").order("name"),
    getCommerceEmailConfig(),
  ]);
  if (error) return NextResponse.json({ error:"Could not load email settings." }, { status:500 });
  return NextResponse.json({ config, templates:templates ?? [], providerConfigured:Boolean(process.env.RESEND_API_KEY) });
}

export async function PATCH(req: NextRequest) {
  const actor = await requirePermission(req, "emails.manage");
  if (!actor) return NextResponse.json({ error:"Forbidden" }, { status:403 });
  const body = await req.json().catch(() => null) as Record<string,unknown>|null;
  if (!body) return NextResponse.json({ error:"Invalid request" }, { status:400 });
  const config = body.config as Record<string,unknown>|undefined;
  if (config) {
    const fromName = clean(config.fromName,80), fromEmail = clean(config.fromEmail,254), replyTo = clean(config.replyTo,254), staffNotificationEmail = clean(config.staffNotificationEmail,254);
    if (!fromName || !email.test(fromEmail) || (replyTo && !email.test(replyTo)) || (staffNotificationEmail && !email.test(staffNotificationEmail))) return NextResponse.json({ error:"Enter valid sender, reply-to, and staff notification addresses." }, { status:400 });
    const emailConfig = { enabled:config.enabled !== false, fromName, fromEmail, replyTo, staffNotificationEmail, sendCustomerMessages:config.sendCustomerMessages !== false, sendStatusUpdates:config.sendStatusUpdates !== false, sendPaymentUpdates:config.sendPaymentUpdates !== false };
    const { error } = await routeServiceClient.from("site_settings").update({ email_config:emailConfig, updated_at:new Date().toISOString() }).eq("singleton",true);
    if (error) return NextResponse.json({ error:"Could not save email settings." }, { status:500 });
  }
  if (Array.isArray(body.templates)) {
    for (const raw of body.templates) {
      const row = raw as Record<string,unknown>; const key = clean(row.key,80);
      const subject = clean(row.subject,200), heading = clean(row.heading,200), templateBody = clean(row.body,5000), buttonLabel = clean(row.button_label,80);
      if (!key || !subject || !heading || !templateBody || !buttonLabel) return NextResponse.json({ error:"Every template field is required." }, { status:400 });
      const { error } = await routeServiceClient.from("email_templates").update({ subject,heading,body:templateBody,button_label:buttonLabel,is_enabled:row.is_enabled !== false,updated_by:actor.userId,updated_at:new Date().toISOString() }).eq("key",key);
      if (error) return NextResponse.json({ error:`Could not save ${key}.` }, { status:500 });
    }
  }
  await logAuditEvent({ actorUserId:actor.userId, actorRole:actor.role, eventType:"staff.email.update", targetTable:"site_settings", targetId:"singleton" });
  return NextResponse.json({ ok:true });
}
