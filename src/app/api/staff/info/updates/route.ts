import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isArray, isString } from "@/lib/typeGuards";

type StatusFilter = "pending" | "approved" | "rejected" | "all";

function normalizeStatus(v: string | null): StatusFilter {
  const s = (v ?? "").trim();
  if (s === "pending" || s === "approved" || s === "rejected" || s === "all") return s;
  return "pending";
}

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["info.updates.view", "info.moderate"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const status = normalizeStatus(url.searchParams.get("status"));

  const [{ count: pendingPagesCount }, { count: pendingUpdatesCount }] = await Promise.all([
    routeServiceClient.from("info_pages").select("id", { count: "exact", head: true }).eq("status", "pending"),
    routeServiceClient
    .from("info_page_updates")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending"),
  ]);

  // info_page_updates stores proposed_* and original_* fields. Current page fields
  // (title/slug/category/chassis/tags) live on info_pages, so we join them.
  let query = routeServiceClient
    .from("info_page_updates")
    .select(
      [
        "id",
        "info_page_id",
        "created_by",
        "created_at",
        "status",
        "proposed_title",
        "proposed_content_markdown",
        "proposed_tags",
        "proposed_category",
        "proposed_chassis",
        "original_title",
        "original_content_markdown",
        "original_tags",
        "original_category",
        "original_chassis",
        // related info page snapshot for staff UI context
        "info_pages(id, title, slug, category, chassis, tags)",
      ].join(", ")
    )
    .order("created_at", { ascending: true });

  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Failed to load updates." }, { status: 500 });

  // Shape to match the staff UI expectations.
  const rawUpdates = isArray(data) ? (data as any[]) : [];
  const updates = rawUpdates.map((u) => {
    const infoPageId = String(u?.info_page_id ?? "");
    const joinedRaw = u?.info_pages;
    const joined = Array.isArray(joinedRaw) ? joinedRaw[0] : joinedRaw;
    const page = {
      id: String(joined?.id ?? infoPageId),
      title: isString(joined?.title) ? joined.title : null,
      slug: isString(joined?.slug) ? joined.slug : null,
      category: isString(joined?.category) ? joined.category : null,
      chassis: isString(joined?.chassis) ? joined.chassis : null,
      tags: isArray(joined?.tags) ? joined.tags : [],
    };
    return {
      ...u,
      created_by: u?.created_by ?? null,
      info_pages: page,
    };
  });
  const pageIds = Array.from(
    new Set(updates.map((u: any) => String(u?.info_page_id ?? "")).filter(Boolean))
  );

  // Meta is keyed by the underlying info page id (matches the UI expectations).
  let metaByPageId: Record<string, any> = {};
  if (pageIds.length) {
    const { data: eventsData } = await routeServiceClient
      .from("info_page_review_events")
      .select("info_page_id, action, notes, performed_by, created_at")
      .in("info_page_id", pageIds);

    const initMeta = () => ({
      notesCount: 0,
      revisionsCount: 0,
      forwarded: false,
      lastEditedAt: null as string | null,
      lastEditedBy: null as string | null,
    });

    for (const id of pageIds) metaByPageId[id] = initMeta();
    if (isArray(eventsData)) {
      for (const ev of eventsData as any[]) {
        const id = String(ev?.info_page_id ?? "");
        if (!id) continue;
        if (!metaByPageId[id]) metaByPageId[id] = initMeta();
        if (isString(ev?.notes) && ev.notes.trim() !== "") metaByPageId[id].notesCount += 1;
        if (ev?.action === "admin_edited" || ev?.action === "admin_undo_edit") metaByPageId[id].revisionsCount += 1;
        if (ev?.action === "admin_forwarded_for_review") metaByPageId[id].forwarded = true;

        const existingTime = metaByPageId[id].lastEditedAt ? new Date(metaByPageId[id].lastEditedAt).getTime() : 0;
        const thisTime = ev?.created_at ? new Date(ev.created_at).getTime() : 0;
        if (thisTime >= existingTime) {
          metaByPageId[id].lastEditedAt = isString(ev?.created_at) ? ev.created_at : null;
          metaByPageId[id].lastEditedBy = isString(ev?.performed_by) ? ev.performed_by : null;
        }
      }
    }
  }

  return NextResponse.json(
    {
      updates,
      metaByPageId,
      pendingCount: typeof pendingPagesCount === "number" ? pendingPagesCount : 0,
      updatesPendingCount: typeof pendingUpdatesCount === "number" ? pendingUpdatesCount : 0,
    },
    { status: 200 }
  );
}
