import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isString, isArray, isRecord } from "@/lib/typeGuards";

type StatusFilter = "pending" | "approved" | "rejected" | "all";

function normalizeStatus(v: string | null): StatusFilter {
  const s = (v ?? "").trim();
  if (s === "pending" || s === "approved" || s === "rejected" || s === "all") return s;
  return "pending";
}

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["info.pending.view", "info.moderate"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const status = normalizeStatus(url.searchParams.get("status"));

  // Counts (best-effort)
  const [{ count: pendingCount }, { count: updatesPendingCount }] = await Promise.all([
    routeServiceClient
      .from("info_pages")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    routeServiceClient
      .from("info_page_updates")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  let query = routeServiceClient
    .from("info_pages")
    .select("id, title, slug, content_markdown, created_at, status, category, chassis, tags")
    .order("created_at", { ascending: true });

  if (status !== "all") query = query.eq("status", status);

  const { data: pagesData, error: pagesError } = await query;
  if (pagesError) {
    return NextResponse.json({ error: "Failed to load submissions." }, { status: 500 });
  }

  const pages = isArray(pagesData) ? pagesData : [];
  const ids = pages.map((p: any) => String(p?.id ?? "")).filter(Boolean);

  let metaById: Record<string, any> = {};
  if (ids.length) {
    const { data: eventsData } = await routeServiceClient
      .from("info_page_review_events")
      .select("info_page_id, action, notes, performed_by, created_at")
      .in("info_page_id", ids);

    const initMeta = () => ({
      notesCount: 0,
      revisionsCount: 0,
      forwarded: false,
      lastEditedAt: null as string | null,
      lastEditedBy: null as string | null,
    });

    for (const id of ids) metaById[id] = initMeta();
    if (isArray(eventsData)) {
      for (const ev of eventsData as any[]) {
        const id = String(ev?.info_page_id ?? "");
        if (!id) continue;
        if (!metaById[id]) metaById[id] = initMeta();
        if (isString(ev?.notes) && ev.notes.trim() !== "") metaById[id].notesCount += 1;
        if (ev?.action === "admin_edited" || ev?.action === "admin_undo_edit") metaById[id].revisionsCount += 1;
        if (ev?.action === "admin_forwarded_for_review") metaById[id].forwarded = true;

        const existingTime = metaById[id].lastEditedAt ? new Date(metaById[id].lastEditedAt).getTime() : 0;
        const thisTime = ev?.created_at ? new Date(ev.created_at).getTime() : 0;
        if (thisTime >= existingTime) {
          metaById[id].lastEditedAt = isString(ev?.created_at) ? ev.created_at : null;
          metaById[id].lastEditedBy = isString(ev?.performed_by) ? ev.performed_by : null;
        }
      }
    }
  }

  return NextResponse.json(
    {
      pages,
      metaById,
      pendingCount: typeof pendingCount === "number" ? pendingCount : 0,
      updatesPendingCount: typeof updatesPendingCount === "number" ? updatesPendingCount : 0,
    },
    { status: 200 }
  );
}
