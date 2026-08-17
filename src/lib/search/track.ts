/**
 * The browser side of search analytics.
 *
 * Two calls, both fire-and-forget, neither able to affect what the customer
 * sees. They post to `/api/public/search-event` and `/api/public/search-click`
 * rather than inserting into Supabase directly — see `analytics.ts` for why the
 * direct inserts this replaces never actually stored anything for a customer.
 *
 * `keepalive` is the point of the fetch options: a search click is immediately
 * followed by a navigation, and a normal request is cancelled when the page
 * goes away. With `keepalive` the browser finishes it in the background, which
 * is the difference between recording the click that mattered and recording
 * only the ones where the customer changed their mind.
 */

import type { SearchResultType, SearchSource } from "@/lib/search/analytics";

/**
 * Record a committed search.
 *
 * "Committed" means Enter, the search button, or picking a suggestion — not
 * every keystroke and not every debounce pause. A row per pause would make the
 * "what do people search for" report mostly a record of people typing, and the
 * partial queries on the way to a real one are not questions anybody asked.
 *
 * Resolves to the event id so a click can be tied to the search that produced
 * it, or null when the event could not be recorded — which the caller ignores,
 * because a click is still worth having without its search.
 */
export async function trackSearch(input: {
  source: SearchSource;
  query: string;
  scope: string;
  resultCount: number;
}): Promise<string | null> {
  try {
    const response = await fetch("/api/public/search-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      keepalive: true,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { id?: string };
    return typeof payload?.id === "string" ? payload.id : null;
  } catch {
    // Analytics must never interfere with searching.
    return null;
  }
}

/** Record which result was chosen, and where in the list it was. */
export function trackSearchClick(input: {
  source: SearchSource;
  searchEventId: string | null;
  resultType: SearchResultType;
  resultId: string;
  /** 0-based rank in the list as the customer saw it. */
  position: number;
  scope: string;
  query: string;
}): void {
  try {
    void fetch("/api/public/search-click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Same rule: never let this reach the customer.
  }
}
