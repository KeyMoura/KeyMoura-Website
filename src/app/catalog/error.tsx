"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

/**
 * Containment for the storefront catalog, one segment wide.
 *
 * `loadCatalogData` throws when the product or media query fails, deliberately:
 * a failed read must never be served as a shop with nothing in it, because a
 * customer cannot tell "KeyMoura sells nothing" from "we could not reach the
 * catalogue", and only one of those is worth coming back from. That rule was
 * already right; what was missing was somewhere for the throw to land. Without
 * this file the only boundary above it is `global-error.tsx`, which replaces
 * the entire document — so a transient database blip took out the header, the
 * navigation, the cart and every route out of the page along with the grid.
 *
 * This is a boundary, not a repair. It exists so an outage costs the product
 * list rather than the site, and so the customer keeps a way to their orders,
 * their account and a human.
 */
export default function CatalogError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="page-container page-stack">
      <div className="ui-card max-w-xl">
        <p className="ui-eyebrow">Catalog</p>
        <h1 className="mt-2 text-2xl font-semibold">Unable to load products</h1>
        <p className="mt-3 text-sm leading-6 text-brand-textMuted">
          This is a problem at our end, not an empty shop — nothing has been discontinued and your cart and
          wishlist are untouched. The problem has been reported. Try again in a moment.
        </p>
        <div className="ui-action-row mt-5">
          <button type="button" onClick={reset} className="ui-btn ui-btn-primary">
            Try again
          </button>
          <Link href="/orders/new" className="ui-btn ui-btn-secondary">
            Start a custom project
          </Link>
          <Link href="/support" className="ui-btn ui-btn-ghost">
            Contact support
          </Link>
        </div>
      </div>
    </main>
  );
}
