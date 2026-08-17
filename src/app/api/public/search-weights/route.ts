import { NextResponse } from "next/server";

import { clickBoost } from "@/lib/search/relevance";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/**
 * The behavioural half of relevance, aggregated, for the `/projects` ranker.
 *
 * ## Why this route exists
 *
 * `/projects` ranks in the browser, so it needs the click signal in the browser.
 * It used to read `info_search_click_events` directly with the anon key — and
 * `select` on that table is staff-only under RLS, so for every customer the
 * query returned nothing and the relevance learning never ran. Aggregating here
 * with the service role is what makes it work at all.
 *
 * ## What it does *not* return
 *
 * No queries. No user ids. No session ids. No timestamps. Not even the click
 * counts.
 *
 * What comes back is a map of project id to a **bounded ranking weight**,
 * 0–`CLICK_BOOST_MAX`, computed by the same `clickBoost` the server-side ranker
 * uses. That is deliberately the least informative thing that still does the
 * job: a weight cannot be read backwards into "how many people clicked this",
 * and it says nothing at all about *who* or *what they searched for*. The
 * analytics themselves stay unreadable outside staff, which is the rule.
 *
 * Only approved — publicly visible — projects appear, so the response cannot
 * reveal that an unpublished page exists.
 *
 * ## Why the weight is capped before it leaves
 *
 * The cap is a property of the ranking, not of the transport, and it is applied
 * on the server so that a client cannot be handed a number large enough to
 * matter even if it ignored the cap itself. See `CLICK_BOOST_MAX`: 200 points
 * inside a 999-point refinement band, against tier bases 1000 apart.
 */

/** Cached briefly: this is a slow-moving aggregate, not a live counter. */
export const revalidate = 300;

/** A ceiling on the aggregation read, so the roll-up is bounded work. */
const MAX_EVENTS = 5_000;

type ClickRow = { clicked_page_id: string | null; position: number | null };

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("info_search_click_events")
      .select("clicked_page_id,position")
      .not("clicked_page_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(MAX_EVENTS);

    if (error || !data) return NextResponse.json({ weights: {} });

    const perPage = new Map<string, { clicks: number; positionTotal: number }>();
    let totalClicks = 0;

    for (const row of data as ClickRow[]) {
      const pageId = row.clicked_page_id;
      if (!pageId) continue;
      const entry = perPage.get(pageId) ?? { clicks: 0, positionTotal: 0 };
      entry.clicks += 1;
      entry.positionTotal += Math.max(0, Math.min(row.position ?? 0, 200));
      perPage.set(pageId, entry);
      totalClicks += 1;
    }

    if (!perPage.size) return NextResponse.json({ weights: {} });

    /*
     * Only pages the public can already see.
     *
     * Without this, a weight for an id the visitor cannot reach would confirm
     * that a draft or withdrawn write-up exists — a small leak, and an
     * unnecessary one, since a page nobody can open cannot be a search result.
     */
    const { data: visible } = await supabaseAdmin
      .from("info_pages")
      .select("id")
      .eq("status", "approved")
      .in("id", [...perPage.keys()]);

    const weights: Record<string, number> = {};
    for (const row of (visible ?? []) as { id: string }[]) {
      const entry = perPage.get(row.id);
      if (!entry) continue;
      weights[row.id] = clickBoost({
        // Share of the clicks recorded, not a true click-through rate:
        // impressions are counted per search rather than per result, which the
        // proposed migration changes. Bounded either way.
        impressions: totalClicks,
        clicks: entry.clicks,
        averagePosition: entry.clicks ? entry.positionTotal / entry.clicks : 0,
      });
    }

    return NextResponse.json({ weights });
  } catch {
    // A ranking without behaviour is still a ranking.
    return NextResponse.json({ weights: {} });
  }
}
