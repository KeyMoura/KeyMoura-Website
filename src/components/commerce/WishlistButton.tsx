"use client";

import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faHeart as faHeartSolid } from "@fortawesome/free-solid-svg-icons";
import { faHeart as faHeartOutline } from "@fortawesome/free-regular-svg-icons";
import { useIsWishlisted, useWishlistMutations } from "@/lib/hooks/useWishlist";

/**
 * The save-to-wishlist toggle.
 *
 * Rendered on product cards as an icon and on product pages with a label. Both
 * are the same control: a real `<button>` with `aria-pressed`, so a screen
 * reader announces the saved state rather than just the word "heart", and the
 * keyboard reaches it in document order.
 *
 * Unlike the cart button this is shown for every product regardless of purchase
 * mode — saving a made-to-order piece for later is exactly what a wishlist is
 * for. Whether it can then be *bought* is decided when it moves to the cart.
 */

type WishlistButtonProps = {
  productId: string;
  productName: string;
  selectedOptions?: Record<string, string>;
  variant?: "icon" | "full";
  className?: string;
};

export default function WishlistButton({
  productId,
  productName,
  selectedOptions = {},
  variant = "full",
  className = "",
}: WishlistButtonProps) {
  const saved = useIsWishlisted(productId);
  const { add, remove } = useWishlistMutations();
  const [error, setError] = useState("");

  const pending = add.isPending || remove.isPending;

  function toggle() {
    setError("");
    const onError = (cause: Error) => setError(cause.message);
    if (saved) remove.mutate({ productId }, { onError });
    else add.mutate({ productId, selectedOptions }, { onError });
  }

  // The accessible name carries the product, so a screen-reader user moving
  // through a grid of cards hears which item each toggle belongs to.
  const label = saved ? `Remove ${productName} from your wishlist` : `Save ${productName} to your wishlist`;

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={saved}
        aria-label={label}
        title={saved ? "Saved to your wishlist" : "Save to your wishlist"}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]/80 text-sm transition hover:border-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:opacity-50 ${
          saved ? "text-brand-primary" : "text-brand-textMuted"
        } ${className}`}
      >
        <FontAwesomeIcon icon={saved ? faHeartSolid : faHeartOutline} className="text-[15px]" />
      </button>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={saved}
        aria-label={label}
        className="ui-btn ui-btn-ghost disabled:opacity-50"
      >
        <FontAwesomeIcon icon={saved ? faHeartSolid : faHeartOutline} className="mr-2 text-[15px]" />
        {pending ? "Saving…" : saved ? "Saved" : "Save for later"}
      </button>

      {/* Politely announced so the toggle's outcome reaches a screen reader
          without stealing focus from the control the user is still on. */}
      <p role="status" aria-live="polite" className="sr-only">
        {saved ? `${productName} is saved to your wishlist.` : ""}
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-amber-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
