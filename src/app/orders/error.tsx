"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";

/**
 * Containment for the order pages, one segment wide.
 *
 * Before this file existed the only boundary in the application was
 * `global-error.tsx`, which replaces the entire document — so a single
 * unreadable field on one order took out the site chrome, the navigation and
 * every other order with it. That is what the customer saw: a bare
 * "Something went wrong" with no way back to their other orders.
 *
 * This is a boundary, not a repair. The data contract is fixed where the data
 * is read — `coerceStoredAddress` and `coercePickupSnapshot` are total, so a
 * historical order shape no longer throws in the first place. This exists so
 * that the *next* unanticipated shape costs one page rather than the whole
 * site, and so the customer keeps a route out of it.
 *
 * Deliberately not a try/catch around each subsection. Swallowing a render
 * error per block would hide a real defect behind a silently missing panel,
 * and a customer cannot tell "this order has no delivery information" from
 * "we failed to show you your delivery information".
 */
export default function OrdersError({
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
        <p className="ui-eyebrow">Order</p>
        <h1 className="mt-2 text-2xl font-semibold">We could not display this order</h1>
        <p className="mt-3 text-sm leading-6 text-brand-textMuted">
          The order itself is fine and nothing has changed — this page failed to draw it. The problem has been
          reported. Try again, or open it from your orders list.
        </p>
        <div className="ui-action-row mt-5">
          <button type="button" onClick={reset} className="ui-btn ui-btn-primary">
            Try again
          </button>
          <Link href="/orders" className="ui-btn ui-btn-secondary">
            Back to your orders
          </Link>
          <Link href="/support" className="ui-btn ui-btn-ghost">
            Contact support
          </Link>
        </div>
      </div>
    </main>
  );
}
