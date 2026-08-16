"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { useCartMutations } from "@/lib/hooks/useCart";
import { useCartDrawer } from "@/components/commerce/CartDrawerProvider";
import { catalogAction, type ActionableProduct } from "@/lib/commerce/catalogActions";

/**
 * The one thing a catalog result asks you to do.
 *
 * Four shapes, decided by `catalogAction` and never by this component:
 *
 *   - **Add to cart** — a real button that adds without leaving the page.
 *   - **Choose options** — a link to the product, because the decision it needs
 *     cannot be made on a tile.
 *   - **Request a quote** — the same, into the request flow.
 *   - **View details** — the fallback for something unavailable.
 *
 * ## Why this is allowed to be a second hit target
 *
 * `ProductCard` exposes exactly one link, stretched over the whole card, and
 * everything decorative is kept *below* that overlay. This control is the
 * documented exception: it is genuinely a different destination from the card,
 * so it earns its own tab stop, and `.product-card-cta` lifts it above the
 * overlay the way `.product-card-aside` lifts the wishlist toggle. A control
 * placed here without that class is a control the card's own anchor swallows.
 *
 * ## Feedback
 *
 * The server returns the whole re-priced cart on every mutation and the shared
 * mutation writes it into the query cache, so the header's cart count moves
 * because the *cart* changed — not because this button guessed it would. A
 * refusal shows the server's own sentence, which is the one that explains which
 * option or which stock level blocked the line.
 *
 * There is no optimistic increment on purpose. An add that the server refuses
 * would otherwise flash a number that then walks backwards, and the refusals
 * this shop can produce (out of stock, a newly required option, a cart line
 * ceiling) are exactly the ones a customer needs to believe.
 *
 * ## Why the drawer opens, and only on the way the drawer *should* open
 *
 * `onSuccess` fires after the mutation has resolved with the server's
 * re-priced cart already written into the query cache, so by the time the sheet
 * slides in it is rendering the real line, the real count and the real subtotal.
 * Nothing about the drawer is predicted: an add that fails takes the `onError`
 * path, which leaves the drawer shut and prints the server's sentence under the
 * button — a sheet that opened to show a cart the customer's item is *not* in
 * would be a worse lie than no feedback at all.
 *
 * Only this branch opens it. "Choose options", "Request a quote" and "View
 * details" are links to the product page, and a cart drawer over a navigation
 * the customer just asked for is a panel in the way of the thing they wanted.
 */

type CatalogProductActionProps = {
  product: ActionableProduct & { id: string; slug: string; name: string };
  /** Where "Choose options" and the request path go. */
  href: string;
};

/** How long the confirmation stays before the button offers to add again. */
const CONFIRM_MS = 2600;

export default function CatalogProductAction({ product, href }: CatalogProductActionProps) {
  const decision = catalogAction(product);
  const { add } = useCartMutations();
  const { openCart } = useCartDrawer();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const timerRef = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  if (decision.kind !== "add_to_cart") {
    return (
      <Link
        href={decision.kind === "request" ? `${href}#request` : href}
        className="product-card-cta product-card-cta-secondary"
        data-action={decision.kind}
      >
        {decision.label}
      </Link>
    );
  }

  const addToCart = () => {
    setError("");
    add.mutate(
      { productId: product.id, quantity: 1 },
      {
        onSuccess: () => {
          setConfirmed(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setConfirmed(false), CONFIRM_MS);
          // Handing the drawer this button is what sends focus back into the
          // middle of the product grid on close, rather than to the top of the
          // document — which on a catalog of a dozen results is the difference
          // between carrying on shopping and finding your place again.
          openCart(buttonRef.current);
        },
        // The server's refusal is the useful message: it names the option or
        // the stock level that stopped the line.
        onError: (cause) => {
          setConfirmed(false);
          setError(cause.message);
        },
      }
    );
  };

  return (
    <div className="product-card-cta-wrap">
      <button
        ref={buttonRef}
        type="button"
        onClick={addToCart}
        disabled={add.isPending}
        className="product-card-cta product-card-cta-primary"
        data-action="add_to_cart"
        data-state={confirmed ? "added" : undefined}
        // The accessible name carries the product, so a screen-reader user
        // moving through a grid hears which item each button belongs to.
        aria-label={`Add ${product.name} to your cart`}
      >
        {confirmed ? (
          <>
            <FontAwesomeIcon icon={faCheck} className="h-3 w-3 shrink-0" aria-hidden="true" />
            Added
          </>
        ) : add.isPending ? (
          "Adding…"
        ) : (
          "Add to cart"
        )}
      </button>

      {/*
        One live region for both outcomes, so a screen reader hears the result
        without the caret leaving the button that produced it. The visible
        confirmation is the button's own label; this is the spoken half.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {confirmed ? `${product.name} added to your cart.` : ""}
      </p>

      {error ? (
        <p role="alert" className="product-card-cta-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
