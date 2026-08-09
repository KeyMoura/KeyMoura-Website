import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";

/**
 * The people and systems that appear in the audit log, for the actor filter.
 *
 * Derived from the log itself rather than from `profiles`, so the dropdown
 * offers exactly the actors that have actually done something. Listing every
 * staff account instead would fill the filter with names that match no rows.
 *
 * Bounded: the most recent slice of events is scanned rather than the whole
 * table. An actor who last acted beyond that window is still reachable — the
 * filter accepts any user id — they just do not appear in the shortlist.
 */

export const runtime = "nodejs";

const SCAN_LIMIT = 2000;

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["audit.view", "audit.read"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await routeServiceClient
    .from("audit_logs")
    .select("actor_user_id,actor_label,actor_kind")
    .order("occurred_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (error) {
    console.error("[audit] actors failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 200) ?? null,
    });
    return NextResponse.json({ actors: [] });
  }

  const byId = new Map<string, { id: string; label: string; kind: string; count: number }>();

  for (const raw of data ?? []) {
    const row = raw as { actor_user_id: string | null; actor_label: string | null; actor_kind: string | null };
    // Everything without a person behind it collapses to one "System" entry:
    // Stripe, Resend and scheduled jobs are not separate people to filter by,
    // and the area filter already separates what they did.
    const id = row.actor_user_id ?? "system";
    const label = row.actor_user_id ? row.actor_label || "Staff" : "System";
    const existing = byId.get(id);
    if (existing) existing.count += 1;
    else byId.set(id, { id, label, kind: row.actor_kind ?? "system", count: 1 });
  }

  const actors = [...byId.values()].sort((a, b) => {
    if (a.id === "system") return 1;
    if (b.id === "system") return -1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });

  return NextResponse.json({ actors });
}
