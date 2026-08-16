"use client";

import Link from "next/link";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import ProductImage from "@/components/ProductImage";
import QuantityField from "@/components/commerce/QuantityField";
import { formatCents, useCart, useCartMutations } from "@/lib/hooks/useCart";

/**
 * The cart, as a sheet from the right-hand edge.
 *
 * ## What this replaces
 *
 * A 380px popover anchored under the cart button, with `max-height: 60vh` on its
 * item list and its subtotal and checkout button *below* that list inside the
 * same box. Three things were wrong with it and all three are structural:
 *
 * 1. **Checkout scrolled away.** The footer was a sibling of the scroll area
 *    inside a panel that had no height of its own, so a cart with four items
 *    pushed *View cart and check out* past the bottom of the panel. The one
 *    control the panel exists to offer was the one a customer had to go looking
 *    for.
 * 2. **It was a dialog that said it was not.** `aria-modal="false"` with focus
 *    moved into it and a `mousedown` listener closing it is the worst of both:
 *    the page behind stayed in the tab order, so Tab walked out of the panel
 *    into content the customer could not see, and nothing announced the panel as
 *    modal because it was not.
 * 3. **It could not grow.** A popover is sized by the button it hangs from. A
 *    cart is sized by how much someone is buying.
 *
 * A right-hand sheet answers all three: it owns the full viewport height, so the
 * header and the footer can be pinned and only the items scroll; it is a real
 * `aria-modal` dialog with a trapped focus ring and a backdrop; and it grows
 * downward without bound because the item region is the only thing that scrolls.
 *
 * ## Layout contract
 *
 *   .cart-drawer-panel   — grid-template-rows: auto minmax(0, 1fr) auto
 *     .cart-drawer-header  — pinned
 *     .cart-drawer-scroll  — the ONLY scrolling region
 *     .cart-drawer-footer  — pinned
 *
 * `minmax(0, 1fr)` on the middle row is the load-bearing part. A plain `1fr`
 * takes the row's min-content size as its floor, which for a list of cart items
 * is the whole list — the row would refuse to shrink, the panel would overflow,
 * and the footer would be pushed off-screen exactly as it was in the popover.
 *
 * ## Portal
 *
 * Rendered onto `<body>`. The provider that owns this already sits outside the
 * header, so the transform trap that forced `MobileNavDrawer` to portal does not
 * apply here — but the page's own stacking contexts do, and a sheet that has to
 * cover a sticky header, a broadcast banner and a product gallery is not
 * something to leave at the mercy of whatever `z-index` it happens to be born
 * into.
 *
 * ## What it deliberately does not do
 *
 * It does not charge anything. The primary action is a link into `/cart`, where
 * the fulfillment panel, the terms notice and the real checkout live. A drawer
 * that took a payment would be a checkout that skipped the agreement flow, which
 * is the one thing this surface must never become.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type CartDrawerProps = {
  open: boolean;
  /** Closing is the provider's job — it also restores focus to the trigger. */
  onClose: () => void;
};

export default function CartDrawer({ open, onClose }: CartDrawerProps) {
  const { data: cart, isLoading, isError } = useCart();
  const { setQuantity, remove } = useCartMutations();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const itemCount = cart?.itemCount ?? 0;
  const items = cart?.items ?? [];
  const unavailable = cart?.unavailable ?? [];

  /*
   * One pending flag for both mutations.
   *
   * Every cart write returns the whole re-resolved cart, so a second write in
   * flight against a stale line is a write against numbers the server is about
   * to replace. Disabling the row's controls while either mutation is running is
   * what keeps the drawer from letting a customer queue up "remove line 2" while
   * "set line 2 to 3" has not come back yet.
   */
  const busy = setQuantity.isPending || remove.isPending;
  const mutationError = setQuantity.error?.message || remove.error?.message || "";

  // Lock the page behind the sheet without losing its scroll position. Same
  // approach as the mobile navigation drawer, for the same reason: `overflow:
  // hidden` alone lets iOS scroll the page under the panel.
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";

    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  /*
   * Initial focus goes to Close, not to the first item link.
   *
   * The drawer opens in two situations, and Close is the right landing spot in
   * both. Opened from the cart button, it is the control a customer who just
   * wanted a glance needs next. Opened automatically after an add, the customer
   * did not ask to be here at all, so the first thing under their hands must be
   * the way out — landing them on a product link would make Enter navigate away
   * from the catalog they were shopping.
   */
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Escape closes; Tab cycles inside the panel.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      // `offsetParent` filters out anything `display: none` has taken out of the
      // layout — the empty state and the item list are never both present, and a
      // trap that included the hidden half would swallow a Tab press.
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="cart-drawer-root">
      {/* Decorative. Escape and the labelled Close button are the accessible
          dismissals; a backdrop in the tab order would be a focus stop that
          announces nothing. */}
      <div className="cart-drawer-backdrop" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="cart-drawer-panel"
        data-testid="cart-drawer"
      >
        <div className="cart-drawer-header">
          <div className="min-w-0">
            <h2 id={titleId} className="cart-drawer-title">
              Your cart
            </h2>
            {/* Not `aria-live`: the count is in the dialog's own heading area and
                the mutation results are announced by the controls that caused
                them. A live region here would re-read the whole cart on every
                quantity step. */}
            <p className="cart-drawer-count">
              {itemCount} {itemCount === 1 ? "item" : "items"}
            </p>
          </div>

          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="cart-drawer-close"
            aria-label="Close cart"
          >
            <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="cart-drawer-scroll">
          {isLoading ? (
            <p className="cart-drawer-message">Loading your cart…</p>
          ) : isError ? (
            <p role="alert" className="ui-notice ui-notice-danger">
              Your cart could not be loaded. Refresh and try again.
            </p>
          ) : !items.length ? (
            /*
             * The empty state, which is a real piece of the shop rather than a
             * blank panel. Someone reaches it two ways — they have never added
             * anything, or they just removed the last thing — and both want the
             * same answer: here is where the products are.
             */
            <div className="cart-drawer-empty">
              <p className="cart-drawer-empty-title">Your cart is empty.</p>
              <p className="cart-drawer-empty-body">
                Browse the catalog to find something to make yours, or send us a drawing and we will quote it.
              </p>
              <Link href="/catalog" onClick={onClose} className="ui-btn ui-btn-primary cart-drawer-empty-action">
                Browse products
              </Link>
              <Link href="/orders/new" onClick={onClose} className="cart-drawer-empty-link">
                Start a custom project
              </Link>
            </div>
          ) : (
            <ul className="cart-drawer-items">
              {items.map((item) => (
                <li key={item.itemId ?? item.productId} className="cart-drawer-item">
                  {/* Decorative: the product name beside it links to the same
                      place, so an empty alt keeps a screen reader from hearing
                      the product twice. */}
                  <Link
                    href={`/catalog/${item.slug}`}
                    onClick={onClose}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="cart-thumb-link cart-drawer-thumb"
                  >
                    <ProductImage product={item.image} alt="" sizes="72px" className="cart-thumb" />
                  </Link>

                  <div className="cart-drawer-item-body">
                    <Link href={`/catalog/${item.slug}`} onClick={onClose} className="cart-drawer-item-name">
                      {item.name}
                    </Link>

                    {/*
                      The customer-facing snapshot the server stored with the
                      line, never the raw option ids. `optionLabels` is what the
                      shop showed at the moment of adding, which is also what the
                      order will be built from — so a staff member renaming an
                      option tomorrow does not rewrite what this customer chose.
                    */}
                    {item.optionLabels.length ? (
                      <p className="cart-drawer-item-options">
                        {item.optionLabels.map((option) => `${option.group}: ${option.label}`).join(" · ")}
                      </p>
                    ) : null}

                    {/* Unit price only where it is not the same number as the
                        line total, which for a quantity of one it always is. */}
                    {item.quantity > 1 ? (
                      <p className="cart-drawer-item-unit">{formatCents(item.unitPriceCents)} each</p>
                    ) : null}

                    <div className="cart-drawer-item-controls">
                      <QuantityField
                        id={`cart-drawer-qty-${item.itemId}`}
                        value={item.quantity}
                        max={item.maxQuantity ?? null}
                        describedItem={item.name}
                        disabled={!item.itemId || busy}
                        showMax={false}
                        size="compact"
                        onCommit={(quantity) =>
                          item.itemId && setQuantity.mutate({ itemId: item.itemId, quantity })
                        }
                      />

                      <button
                        type="button"
                        disabled={!item.itemId || busy}
                        onClick={() => item.itemId && remove.mutate(item.itemId)}
                        className="cart-drawer-remove"
                        aria-label={`Remove ${item.name} from your cart`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <p className="cart-drawer-item-price">{formatCents(item.lineSubtotalCents)}</p>
                </li>
              ))}
            </ul>
          )}

          {/*
            A failed quantity change or removal is reported here, inside the
            scroll region, and the drawer stays open. The server's own sentence
            is the useful one — it names the stock level or the option that
            refused the change.
          */}
          {mutationError ? (
            <p role="alert" className="ui-notice ui-notice-danger cart-drawer-error">
              {mutationError}
            </p>
          ) : null}

          {unavailable.length ? (
            <p role="status" className="ui-notice ui-notice-warning cart-drawer-notice">
              {unavailable.length} item{unavailable.length === 1 ? "" : "s"} in your cart{" "}
              {unavailable.length === 1 ? "is" : "are"} no longer available. Open your cart to review.
            </p>
          ) : null}
        </div>

        {/*
          The footer is pinned for a cart of any size, and it is rendered even
          when the cart is empty — with the subtotal row omitted, because a
          "$0.00" subtotal is a number that invites a customer to wonder what it
          is for. Continue shopping stays, so the empty state has the same way
          out as every other state.
        */}
        <div className="cart-drawer-footer">
          {items.length ? (
            <>
              <div className="cart-drawer-total">
                <span className="cart-drawer-total-label">Subtotal</span>
                {/* The server's number. Never recomputed here from current
                    product prices: a cart line holds the price it was added at,
                    and re-deriving it in the browser is how a drawer ends up
                    disagreeing with checkout. */}
                <span className="cart-drawer-total-value">{formatCents(cart?.subtotalCents ?? 0)}</span>
              </div>

              {cart && cart.discountCents > 0 ? (
                <div className="cart-drawer-total cart-drawer-total-discount">
                  <span className="cart-drawer-total-label">Discount</span>
                  <span className="cart-drawer-total-value">−{formatCents(cart.discountCents)}</span>
                </div>
              ) : null}

              <p className="cart-drawer-fineprint">Shipping and taxes are settled at checkout.</p>

              <Link href="/cart" onClick={onClose} className="ui-btn ui-btn-primary cart-drawer-checkout">
                View cart and check out
              </Link>
            </>
          ) : null}

          <button type="button" onClick={onClose} className="cart-drawer-continue">
            Continue shopping
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
