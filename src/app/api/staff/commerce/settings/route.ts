import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/routeAuth";
import {
  loadCommerceSettings,
  saveCommerceSettings,
} from "@/lib/commerce/commerceSettingsServer";
import { loadCommercePolicy, logLifecycleFailure } from "@/lib/commerce/orderLifecycleServer";
import { logAuditEvent } from "@/lib/audit";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { parseCommerceSettings } from "@/lib/commerce/commerceSettings";
import { parseCommercePolicy } from "@/lib/commerce/orderLifecycle";

/**
 * Commerce settings: shipping, local pickup, inventory, email, and the
 * cancellation and return policy the pass-7 lifecycle already reads.
 *
 * Both jsonb columns are written here because they are one screen to the
 * owner. `commerce_policy` predates this pass and keeps its own parser and its
 * own column; putting its editing surface somewhere else would mean two places
 * to look for "when can a customer cancel".
 *
 * Nothing is consequential until POST. Selecting a value in the form changes
 * nothing server-side.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "commerce.settings.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [settings, policy] = await Promise.all([loadCommerceSettings(), loadCommercePolicy()]);
  return NextResponse.json({ settings, policy });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "commerce.settings.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const previous = await loadCommerceSettings();
  const previousPolicy = await loadCommercePolicy();

  // Parsed, never trusted. What is stored is what the total parser produced
  // from the request, so a field the form omitted falls back to a known
  // default rather than being written as undefined and read back as garbage.
  //
  // `automation` is the one exception, and it has to be. It lives inside the
  // same jsonb column but is edited on `/staff/settings/automation` under a
  // different permission, and this form does not render it — so "fall back to a
  // known default" would mean every save of a shipping price silently reset the
  // reminder thresholds to theirs. Carried forward from the stored row instead,
  // which makes this route structurally unable to change them.
  const settings = { ...parseCommerceSettings(body.settings), automation: previous.automation };
  const policy = parseCommercePolicy(body.policy);

  // Refusals that the parser cannot express, because they are about coherence
  // rather than about the shape of one value. Each names the fix.
  const problems: string[] = [];

  if (settings.shipping.enabled) {
    if (!settings.shipping.methods.some((method) => method.enabled)) {
      problems.push("Shipping is on but no delivery method is enabled. Add one, or turn shipping off.");
    }
    if (!settings.shipping.destinationCountries.length) {
      problems.push("Shipping is on but no destination country is selected.");
    }
    if (!settings.shipping.originAddress.line1.trim() || !settings.shipping.originAddress.postalCode.trim()) {
      problems.push("Shipping is on but the origin address is incomplete. Parcels need a return-from address.");
    }
  }
  if (settings.pickup.enabled) {
    if (!settings.pickup.address.line1.trim()) {
      problems.push("Local pickup is on but the pickup address is empty. Customers cannot collect from nowhere.");
    }
    if (!settings.pickup.instructions.trim()) {
      problems.push("Local pickup is on but there are no customer-visible instructions.");
    }
  }
  // Promising fixed hours the shop cannot keep is worse than saying nothing.
  if (settings.pickup.enabled && settings.pickup.requireConfirmation && !settings.pickup.hoursText.trim()) {
    problems.push(
      "Pickup confirmation is required but no hours are given, so a customer has no way to know when to come."
    );
  }

  if (problems.length) {
    return NextResponse.json({ error: problems[0], problems }, { status: 400 });
  }

  const [settingsSaved, policySaved] = await Promise.all([
    saveCommerceSettings(settings),
    (async () => {
      const { error } = await routeServiceClient
        .from("site_settings")
        .update({ commerce_policy: policy, updated_at: new Date().toISOString() })
        .eq("singleton", true);
      if (error) {
        logLifecycleFailure("save_commerce_policy", error);
        return { ok: false };
      }
      return { ok: true };
    })(),
  ]);

  if (!settingsSaved.ok || !policySaved.ok) {
    return NextResponse.json({ error: "Could not save commerce settings." }, { status: 500 });
  }

  /**
   * The audit records *which sections changed*, never the values.
   *
   * An address, a support email and a set of staff alert recipients are all
   * personal data, and the audit log is read more widely and kept longer than
   * the settings page. "Who changed the shipping prices, and when" is the
   * question this has to answer; "to what" is answered by the settings page
   * itself.
   */
  const sections: string[] = [];
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  if (changed(previous.business, settings.business)) sections.push("business");
  if (changed(previous.shipping, settings.shipping)) sections.push("shipping");
  if (changed(previous.pickup, settings.pickup)) sections.push("pickup");
  if (changed(previous.inventory, settings.inventory)) sections.push("inventory");
  if (changed(previous.email, settings.email)) sections.push("email");
  if (changed(previous.returnAddress, settings.returnAddress)) sections.push("return_address");
  if (changed(previousPolicy, policy)) sections.push("policy");

  if (sections.length) {
    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: "staff",
      eventType: "staff.commerce.settings_changed",
      targetTable: "site_settings",
      targetId: "singleton",
      metadata: {
        sections: sections.join(","),
        shipping_enabled: settings.shipping.enabled,
        pickup_enabled: settings.pickup.enabled,
        method_count: settings.shipping.methods.length,
        reservation_minutes: settings.inventory.reservationMinutes,
      },
    });
  }

  return NextResponse.json({ ok: true, settings, policy, changedSections: sections });
}
