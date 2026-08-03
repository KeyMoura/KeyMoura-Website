"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CART_QUERY_KEY } from "@/lib/hooks/useCart";
import { WISHLIST_QUERY_KEY } from "@/lib/hooks/useWishlist";

/**
 * Copy actions on a shared wishlist.
 *
 * The token identifies which list is being copied *from*; it never identifies
 * who is copying. The viewer's own cart and wishlist are resolved server-side
 * from their own cookies, and every copied line is revalidated there, so this
 * component cannot smuggle a price or an unavailable product through.
 */

type SharedWishlistActionsProps = {
  token: string;
  productId?: string;
  productName: string;
  cartEligible: boolean;
  /** Copies every applicable item rather than one. */
  bulk?: boolean;
  className?: string;
};

export default function SharedWishlistActions({
  token,
  productId,
  productName,
  cartEligible,
  bulk = false,
  className = "",
}: SharedWishlistActionsProps) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<"cart" | "wishlist" | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function copy(destination: "cart" | "wishlist") {
    setPending(destination);
    setMessage("");
    setFailed(false);

    try {
      const response = await fetch(`/api/wishlist/shared/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ destination, productId: bulk ? undefined : productId }),
      });

      const payload = (await response.json().catch(() => null)) as
        | { copied?: number; failures?: string[]; error?: string; cart?: unknown; wishlist?: unknown }
        | null;

      if (!response.ok) {
        setFailed(true);
        setMessage(payload?.error || payload?.failures?.[0] || "That could not be copied.");
        return;
      }

      // The response carries the viewer's own re-resolved collection, so the
      // navbar counts update without a second round trip.
      if (payload?.cart) queryClient.setQueryData(CART_QUERY_KEY, payload.cart);
      if (payload?.wishlist) queryClient.setQueryData(WISHLIST_QUERY_KEY, payload.wishlist);

      const count = payload?.copied ?? 0;
      const problems = payload?.failures?.length ? ` ${payload.failures.length} could not be copied.` : "";
      setMessage(
        bulk
          ? `${count} item${count === 1 ? "" : "s"} copied to your ${destination}.${problems}`
          : `Copied to your ${destination}.`
      );
    } catch {
      setFailed(true);
      setMessage("That could not be copied. Check your connection and try again.");
    } finally {
      setPending(null);
    }
  }

  const cartLabel = bulk ? "Copy all to my cart" : `Add ${productName} to my cart`;
  const wishlistLabel = bulk ? "Copy all to my wishlist" : `Save ${productName} to my wishlist`;

  return (
    <div className={className}>
      <div className={bulk ? "grid gap-2" : "ui-action-row mt-3"}>
        {cartEligible ? (
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void copy("cart")}
            aria-label={cartLabel}
            className={`ui-btn ui-btn-primary disabled:opacity-50 ${bulk ? "w-full" : "!py-1.5 text-sm"}`}
          >
            {pending === "cart" ? "Adding…" : bulk ? "Copy all to my cart" : "Add to my cart"}
          </button>
        ) : null}

        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void copy("wishlist")}
          aria-label={wishlistLabel}
          className={`ui-btn ui-btn-ghost disabled:opacity-50 ${bulk ? "w-full text-sm" : "!py-1.5 text-sm"}`}
        >
          {pending === "wishlist" ? "Saving…" : bulk ? "Copy all to my wishlist" : "Save for later"}
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
