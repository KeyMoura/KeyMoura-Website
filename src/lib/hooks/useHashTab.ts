"use client";

import { useCallback, useEffect, useState } from "react";

import { resolveTabWithAliases, type StaffTab } from "@/lib/staff/pageFramework";

/**
 * Tab state kept in the URL hash.
 *
 * ## Why the hash rather than a query parameter
 *
 * The order workspace's sections were reachable by anchor before this pass, and
 * those anchors are linked from three other pages: the fulfillment queue sends
 * you to `/staff/orders/<id>#fulfillment`, the production panel to
 * `#production`, and the order page's own "next step" button to `#quote`.
 * Turning the sections into tabs with a `?tab=` parameter would have silently
 * broken all of them — the link would still resolve, land on Overview, and the
 * reader would conclude the thing they clicked through for was gone.
 *
 * Keeping the state in the hash means every one of those links keeps meaning
 * what it meant, through the alias table in `pageFramework.ts`. It also costs
 * no `useSearchParams`, so a page using tabs does not have to grow a Suspense
 * boundary or opt out of prerendering.
 *
 * ## Why the value is read in an effect
 *
 * `window.location.hash` is not available during server rendering, and reading
 * it during the first client render is a hydration mismatch. So the first paint
 * is always the default tab and the hash is applied immediately afterwards —
 * one extra render, only when a hash is present, in exchange for markup that
 * matches. `hashchange` is subscribed for the same reason: `history.pushState`
 * does not fire it, but the back button and an in-page anchor both do.
 */
export function useHashTab(
  tabs: readonly StaffTab[],
  aliases: Readonly<Record<string, string>> = {}
): [string | null, (id: string) => void] {
  const fallback = resolveTabWithAliases(tabs, null, aliases);
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    const read = () => setHash(window.location.hash.replace(/^#/, "") || null);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  const active = hash === null ? fallback : resolveTabWithAliases(tabs, hash, aliases);

  const select = useCallback((id: string) => {
    setHash(id);
    // `replaceState` rather than assigning `location.hash`: assigning it
    // scrolls the matching element into view, and every tab id here also names
    // a panel — so switching tabs would jump the page down to the panel it had
    // just revealed.
    window.history.replaceState(null, "", `#${id}`);
  }, []);

  return [active, select];
}
