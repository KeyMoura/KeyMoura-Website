"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CART_QUERY_KEY } from "@/lib/hooks/useCart";

/**
 * The copy action on a shared cart.
 *
 * Sends only the token and, for a single line, which product. Never a price,
 * never a quantity the server did not already record in the snapshot, and
 * never anything identifying the list's owner.
 */

type SharedCartActionsProps = {
  token: string;
  productId?: string;
  productName: string;
  /** Copies every currently buyable line rather than one. */
  bulk?: boolean;
  className?: string;
};

export default function SharedCartActions({
  token,
  productId,
  productName,
  bulk = false,
  className = "",
}: SharedCartActionsProps) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function copy() {
    setPending(true);
    setMessage("");
    setFailed(false);

    try {
      const response = await fetch(`/api/cart/shared/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ productId: bulk ? undefined : productId }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { copied?: number; failures?: string[]; error?: string; cart?: unknown }
        | null;

      if (!response.ok) {
        setFailed(true);
        setMessage(payload?.error || payload?.failures?.[0] || "That could not be added to your cart.");
        return;
      }

      // The response carries the viewer's own re-resolved cart, so the navbar
      // count updates without a second round trip.
      if (payload?.cart) queryClient.setQueryData(CART_QUERY_KEY, payload.cart);

      const count = payload?.copied ?? 0;
      const problems = payload?.failures?.length ? ` ${payload.failures.length} could not be added.` : "";
      setMessage(
        bulk ? `${count} item${count === 1 ? "" : "s"} added to your cart.${problems}` : "Added to your cart."
      );
    } catch {
      setFailed(true);
      setMessage("That could not be added. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={className}>
      <div className={bulk ? "" : "ui-action-row mt-3"}>
        <button
          type="button"
          disabled={pending}
          onClick={() => void copy()}
          aria-label={bulk ? "Copy every available item to my cart" : `Add ${productName} to my cart`}
          className={`ui-btn ui-btn-primary disabled:opacity-50 ${bulk ? "w-full" : "!py-1.5 text-sm"}`}
        >
          {pending ? "Adding…" : bulk ? "Copy all to my cart" : "Add to my cart"}
        </button>
      </div>

      {message ? (
        <p
          role={failed ? "alert" : "status"}
          aria-live="polite"
          className={`mt-2 text-sm ${failed ? "text-amber-200" : "text-emerald-300"}`}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
