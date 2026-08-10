import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { resolveStaffRecipients } from "@/lib/orderNotifications";

/**
 * Who a support conversation may be assigned to.
 *
 * Resolved from the **permission**, through the same `resolveStaffRecipients`
 * the assign route enforces with and the notification fan-out delivers to. One
 * definition of "the support desk", not three: a dropdown that offered somebody
 * the assign route would then refuse is a control that lies, and a dropdown
 * built from a role list would miss anybody holding the permission by direct
 * grant.
 *
 * Returns display names only. Not email addresses: this is a routing control,
 * and a staff directory is what `/staff/users` is for.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // `support.view` rather than `support.assign`: the workspace needs the names
  // to *render* an existing assignment readably even for somebody who cannot
  // change it.
  const actor = await requirePermission(req, "support.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // `null` actor, so the caller sees themselves in the list. The fan-out excludes
  // the actor because telling somebody about their own action is noise; taking a
  // conversation yourself is the single most common assignment there is.
  const ids = await resolveStaffRecipients("support.view", null);
  if (!ids.length) return NextResponse.json({ assignees: [] });

  const { data, error } = await routeServiceClient
    .from("profiles")
    .select("id,display_name,username,avatar_url")
    .in("id", ids);

  if (error) {
    console.error("[support] assignees failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load the support team." }, { status: 500 });
  }

  const rows = (data ?? []) as { id: string; display_name: string | null; username: string | null; avatar_url: string | null }[];

  return NextResponse.json({
    assignees: rows
      .map((row) => ({
        id: row.id,
        label: row.display_name?.trim() || row.username?.trim() || `User ${row.id.slice(0, 8)}`,
        avatarUrl: row.avatar_url,
        isSelf: row.id === actor.userId,
      }))
      .sort((a, b) => (a.isSelf === b.isSelf ? a.label.localeCompare(b.label) : a.isSelf ? -1 : 1)),
  });
}
