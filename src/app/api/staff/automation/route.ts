import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/api/routeAuth";
import { loadCommerceSettings, saveCommerceSettings } from "@/lib/commerce/commerceSettingsServer";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { loadAutomationHealth, listJobs } from "@/lib/automation/health";
import { SCHEDULER_INTERVAL_MINUTES } from "@/lib/automation/cadence";
import { recordAuditEvent } from "@/lib/audit/events";
import type { AutomationJobState } from "@/lib/automation/catalogue";

/**
 * The staff automation surface: settings, health and the job list.
 *
 * Reading and changing are separated, as they are everywhere else in this
 * application: `automation.view` sees what the scheduler is doing, and
 * `automation.manage` decides when customers get written to. The second is a
 * genuinely different power — a threshold is the difference between a reminder
 * and a nuisance — and it is not granted to any non-admin role by default.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["automation.view", "automation.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const stateParam = url.searchParams.get("state");
  const state = (["pending", "running", "completed", "cancelled", "failed"] as const).includes(
    stateParam as AutomationJobState
  )
    ? (stateParam as AutomationJobState)
    : undefined;

  const [settings, health, jobs, failures] = await Promise.all([
    loadCommerceSettings(),
    loadAutomationHealth(),
    listJobs({ state, limit: 50 }),
    // Failures are always loaded, whatever the filter. They are the reason
    // somebody opened this page, and making them a tab you have to find is how a
    // failed reminder stays failed.
    listJobs({ state: "failed", limit: 25 }),
  ]);

  return NextResponse.json({
    settings: settings.automation,
    health,
    jobs,
    failures,
    intervalMinutes: SCHEDULER_INTERVAL_MINUTES,
    canManage: actor.permissions.has("automation.manage"),
  });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "automation.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const current = await loadCommerceSettings();
  const previous = current.automation;
  // Total parser: every field comes back a number or a boolean whatever arrived,
  // and out-of-range values are clamped rather than rejected.
  const automation = parseAutomationSettings(body.settings);

  /*
   * Read-modify-write of the one key.
   *
   * `commerce_settings` is a single jsonb column holding shipping, pickup,
   * inventory, email and this. Writing only `{ automation }` would erase all of
   * it. The rest is carried through untouched — this route has no business
   * changing a shipping price, and structurally cannot.
   */
  const saved = await saveCommerceSettings({ ...current, automation });
  if (!saved.ok) return NextResponse.json({ error: "Could not save automation settings." }, { status: 500 });

  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const sections: string[] = [];
  if (previous.enabled !== automation.enabled) sections.push("master_switch");
  if (changed(previous.orders, automation.orders)) sections.push("orders");
  if (changed(previous.production, automation.production)) sections.push("production");
  if (changed(previous.fulfillment, automation.fulfillment)) sections.push("fulfillment");
  if (changed(previous.support, automation.support)) sections.push("support");

  if (sections.length) {
    /*
     * The thresholds themselves are recorded, unlike the commerce settings route
     * which deliberately logs only which sections moved. The difference is that
     * these values are not personal data — they are integers describing timing —
     * and "somebody set the support alert to 336 hours and nobody noticed for a
     * month" is exactly the question this log should be able to answer.
     */
    await recordAuditEvent({
      action: "automation.settings_changed",
      actor: { kind: "staff", userId: actor.userId, role: actor.role },
      entity: { type: "setting", id: "commerce_settings.automation", label: "Automation" },
      summary: `Changed automation settings: ${sections.join(", ")}.`,
      source: "staff_ui",
      metadata: {
        sections: sections.join(","),
        enabled: automation.enabled,
        quote_warning_hours: automation.orders.quoteExpiryWarningHours,
        pickup_days: automation.fulfillment.pickupReminderDays.join(","),
        support_staff_hours: automation.support.waitingOnStaffHours,
        support_customer_days: automation.support.waitingOnCustomerDays,
        production_due_days: automation.production.dueSoonDays,
        production_blocked_hours: automation.production.blockedHours,
      },
    });
  }

  return NextResponse.json({ ok: true, settings: automation, changedSections: sections });
}
