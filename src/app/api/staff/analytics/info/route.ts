import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

type SearchEventRow = {
  id: string;
  created_at: string;
  source: string | null;
  raw_query: string | null;
  tokens: string[] | null;
  results_count: number | null;
  top_result_id: string | null;
  top_result_slug: string | null;
  meta: Record<string, unknown> | null;
};

type ClickEventRow = {
  id: string;
  created_at: string;
  source: string | null;
  search_event_id: string | null;
  raw_query: string | null;
  tokens: string[] | null;
  clicked_page_id: string | null;
  clicked_page_slug: string | null;
  position: number | null;
  results_count: number | null;
  meta: Record<string, unknown> | null;
};

/**
 * Returns staff-only analytics for the Info search feature.
 *
 * This uses the service-role client so it does not depend on client-side RLS policies.
 */
export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "analytics.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [searchRes, clickRes] = await Promise.all([
    routeServiceClient
      .from("info_search_events")
      .select("id, created_at, source, raw_query, tokens, results_count, top_result_id, top_result_slug, meta")
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<SearchEventRow[]>(),
    routeServiceClient
      .from("info_search_click_events")
      .select(
        "id, created_at, source, search_event_id, raw_query, tokens, clicked_page_id, clicked_page_slug, position, results_count, meta"
      )
      .order("created_at", { ascending: false })
      .limit(200)
      .returns<ClickEventRow[]>(),
  ]);

  if (searchRes.error) {
    return NextResponse.json({ error: searchRes.error.message }, { status: 500 });
  }
  if (clickRes.error) {
    return NextResponse.json({ error: clickRes.error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      ok: true,
      searchEvents: searchRes.data ?? [],
      clickEvents: clickRes.data ?? [],
    },
    { status: 200 }
  );
}
