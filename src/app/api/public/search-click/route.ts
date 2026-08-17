import { NextRequest, NextResponse } from "next/server";

import { canStoreClick, validateClickEvent } from "@/lib/search/analytics";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Records which search result was actually chosen.
 *
 * This is the other half of the relevance signal: a search event says what was
 * asked and how much came back, and this says which of the answers was the one.
 * Together they are the click-through rate `clickBoost` consumes, capped at 200
 * points inside a single tier so it can refine an ordering and never rewrite
 * one.
 *
 * ## Everything the client sends is checked
 *
 * The client is the thing being measured, so nothing it says is taken on trust:
 *
 *   - `resultType` and `source` are closed sets — an invented value is refused,
 *     not stored;
 *   - `resultId` must be a uuid, because it is the field that decides *which*
 *     row accumulates behaviour, and it is checked against a real row below;
 *   - `position` is bounded, because it is the input to the position
 *     normalization in the boost;
 *   - `searchEventId`, when present, must be a uuid and must name a search
 *     event that exists — a click cannot invent the search it came from.
 *
 * The strongest guarantee is not any of those, though: it is that the boost
 * these events feed is capped below the width of one tier. Even a caller that
 * passed every check above and hammered this endpoint could not move a result
 * past a better textual match. Validation keeps the data clean; the cap is what
 * keeps the ranking honest.
 *
 * ## What it can store today
 *
 * `info_search_click_events.clicked_page_id` is a foreign key into
 * `info_pages`, so the table can hold a click on a project and nothing else. A
 * product or category click is validated, recognised, and then declined with
 * `stored: false` rather than being forced into a column that means something
 * different — see `STORABLE_CLICK_TYPES`, and `docs/search-architecture.md` for
 * the migration that generalizes the table.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;

export async function POST(req: NextRequest) {
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new NextResponse(null, { status: 204 });
    }
    if (!parsed || typeof parsed !== "object") return new NextResponse(null, { status: 204 });

    const body = parsed as Record<string, unknown>;
    const result = validateClickEvent({
      source: body.source,
      searchEventId: body.searchEventId,
      resultType: body.resultType,
      resultId: body.resultId,
      position: body.position,
      scope: body.scope,
      query: body.query,
    });
    if (!result.ok) return NextResponse.json({ stored: false, reason: result.reason }, { status: 202 });

    const click = result.value;
    if (!canStoreClick(click.resultType)) {
      return NextResponse.json({ stored: false, reason: "result type not yet storable" }, { status: 202 });
    }

    /*
     * The id has to name a real, publicly visible row.
     *
     * Without this a caller could attach clicks to any uuid it liked — an
     * unpublished draft, a deleted page, or a value chosen to collide with
     * something. The foreign key would catch a total fabrication; it would not
     * catch a real id belonging to a row the public cannot see.
     */
    const { data: page, error: lookupError } = await supabaseAdmin
      .from("info_pages")
      .select("id,slug")
      .eq("id", click.resultId)
      .eq("status", "approved")
      .maybeSingle();
    if (lookupError || !page) {
      return NextResponse.json({ stored: false, reason: "unknown result" }, { status: 202 });
    }

    // Likewise the search event: a click may reference one, but only one that
    // exists. An unknown id is dropped rather than stored as a dangling link.
    let searchEventId: string | null = null;
    if (click.searchEventId) {
      const { data: event } = await supabaseAdmin
        .from("info_search_events")
        .select("id")
        .eq("id", click.searchEventId)
        .maybeSingle();
      searchEventId = event ? (event.id as string) : null;
    }

    const { error } = await supabaseAdmin.from("info_search_click_events").insert({
      source: click.source,
      search_event_id: searchEventId,
      clicked_page_id: page.id as string,
      clicked_page_slug: page.slug as string,
      query: click.normalizedQuery,
      raw_query: click.rawQuery,
      tokens: click.tokens,
      position: click.position,
      meta: { scope: click.scope },
    });

    if (error) return NextResponse.json({ stored: false, reason: "write failed" }, { status: 202 });
    return NextResponse.json({ stored: true });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
