import { NextRequest, NextResponse } from "next/server";

import { validateSearchEvent } from "@/lib/search/analytics";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * Records that a search happened.
 *
 * ## Why a route rather than a browser insert
 *
 * Because the browser insert has never worked. `/projects` and the command
 * palette both write to `info_search_events` with the anon key, and the table's
 * only permissive policy is `staff manage` (`is_staff_user()`), so every
 * customer's insert is rejected by RLS and swallowed by a `catch`. Production
 * holds seven rows, all from staff.
 *
 * Writing through the service role from here is what makes the feature real,
 * and it is also what makes the validation meaningful: the payload decides
 * ranking inputs, so it has to be checked somewhere the client cannot reach.
 * `validateSearchEvent` is that check, and it is pure and tested.
 *
 * ## What it stores
 *
 * The query as typed, the query normalized, its tokens, the scope, and how many
 * results came back. No IP, no user agent, no referrer. The scope goes in
 * `filters`, which is the jsonb column the table already has for exactly this —
 * no schema change was needed to start recording scoped searches.
 *
 * ## Failure is silent, by design
 *
 * Analytics must never be able to break a search. Every error path returns 204,
 * because the caller is a fire-and-forget `sendBeacon`/`keepalive` fetch on the
 * customer's critical path and there is nothing useful it could do with a 500.
 * What the caller *does* get, on success, is the row id — so a subsequent click
 * can be tied to the search that produced it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A body larger than this is not a search event. */
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
    const result = validateSearchEvent({
      source: body.source,
      query: body.query,
      scope: body.scope,
      resultCount: body.resultCount,
    });
    if (!result.ok) return new NextResponse(null, { status: 204 });

    const event = result.value;
    const { data, error } = await supabaseAdmin
      .from("info_search_events")
      .insert({
        source: event.source,
        query: event.normalizedQuery,
        raw_query: event.rawQuery,
        tokens: event.tokens,
        results_count: event.resultCount,
        result_count: event.resultCount,
        // The scope lives in the jsonb the table already carries. A dedicated
        // column would be tidier and is part of the proposed migration; this
        // works today and is what the roll-up reads.
        filters: { scope: event.scope },
      })
      .select("id")
      .single();

    if (error || !data) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ id: data.id as string });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
}
