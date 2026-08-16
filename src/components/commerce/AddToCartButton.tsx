"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useCartMutations } from "@/lib/hooks/useCart";
import { useCartDrawer } from "@/components/commerce/CartDrawerProvider";
import { allowsDirectPurchase, allowsRequest, type PurchaseMode } from "@/lib/commerce/purchaseModes";

/**
 * The buy actions for one product.
 *
 * What renders is decided by the product's purchase mode:
 *
 * - `direct_purchase`  — add to cart only
 * - `request_only`     — request a quote only, never a cart button
 * - `direct_or_request`— both, with the standard purchase leading
 *
 * This is a convenience, not a control. The server re-checks the mode when the
 * item is added, when the cart is displayed, and again at checkout, so hiding
 * or showing a button here cannot change what is actually purchasable.
 *
 * A successful add opens the cart drawer, the same as the catalog's quick-add,
 * so the confirmation is the cart itself rather than a sentence claiming
 * something happened. The `request_only` and "request a custom version" paths
 * are links and never touch the cart, so they never open it — a request is not a
 * purchase and must not be made to look like one.
 */

type AddToCartButtonProps = {
  productId: string;
  purchaseMode: PurchaseMode;
  /** Null when the product has no fixed price, which forces the request path. */
  startingPriceCents: number | null;
  available: boolean;
  selectedOptions?: Record<string, string>;
  requestHref: string;
  quantity?: number;
};

export default function AddToCartButton({
  productId,
  purchaseMode,
  startingPriceCents,
  available,
  selectedOptions = {},
  requestHref,
  quantity = 1,
}: AddToCartButtonProps) {
  const { add } = useCartMutations();
  const { openCart } = useCartDrawer();
  const [message, setMessage] = useState("");
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const canBuy = allowsDirectPurchase(purchaseMode) && startingPriceCents != null && available;
  const canRequest = allowsRequest(purchaseMode);

  function addToCart() {
    setMessage("");
    add.mutate(
      { productId, quantity, selectedOptions },
      {
        onSuccess: () => {
          setMessage("Added to your cart.");
          // Only here — after the server has returned the re-priced cart. A
          // refused add falls through to `onError` and the drawer stays shut.
          openCart(buttonRef.current);
        },
        // The server's refusal is the useful message here — it explains which
        // option or which stock level blocked the line.
        onError: (error) => setMessage(error.message),
      }
    );
  }

  if (!canBuy && !canRequest) {
    return (
      <p className="ui-notice ui-notice-info" role="status">
        This product is not currently available.
      </p>
    );
  }

  return (
    <div>
      <div className="ui-action-row">
        {canBuy ? (
          <button
            ref={buttonRef}
            type="button"
            onClick={addToCart}
            disabled={add.isPending}
            className="ui-btn ui-btn-primary disabled:opacity-50"
          >
            {add.isPending ? "Adding…" : "Add to cart"}
          </button>
        ) : null}

        {canRequest ? (
          <Link href={requestHref} className={canBuy ? "ui-btn ui-btn-secondary" : "ui-btn ui-btn-primary"}>
            {canBuy ? "Request a custom version" : "Request a quote"}
          </Link>
        ) : null}
      </div>

      {canBuy && canRequest ? (
        <p className="mt-2 text-xs text-brand-textMuted">
          Buy the standard version now, or request changes and we will price them first.
        </p>
      ) : null}

      {message ? (
        <p
          role="status"
          aria-live="polite"
          className={`mt-3 text-sm ${add.isError ? "text-amber-200" : "text-emerald-300"}`}
        >
          {message}{" "}
          {!add.isError ? (
            <Link href="/cart" className="underline hover:no-underline">
              View cart
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
