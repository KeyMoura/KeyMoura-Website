"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCartShopping } from "@fortawesome/free-solid-svg-icons";
import ProductImage from "@/components/ProductImage";
import { badgeCount, badgeLabel } from "@/lib/navBadge";
import { formatCents, useCart, useCartMutations } from "@/lib/hooks/useCart";

/**
 * The navbar cart button and its drawer.
 *
 * Uses the dedicated navbar utility colors rather than theme colors, matching
 * the notification bell beside it, so Appearance keeps full control of the
 * navbar without this control drifting from its neighbours.
 *
 * The drawer is a dialog: focus moves into it, Escape closes it, and focus
 * returns to the button that opened it.
 */

const pillClass = (highlighted: boolean) =>
  `inline-flex h-9 w-9 items-center justify-center rounded-full border text-sm site-nav-utility${
    highlighted ? " is-highlighted" : ""
  }`;

export default function CartIndicator() {
  const { data: cart, isLoading, isError } = useCart();
  const { setQuantity, remove } = useCartMutations();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  const itemCount = cart?.itemCount ?? 0;
  const hasUnavailable = Boolean(cart?.unavailable.length);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    // Moving focus into the panel is what makes this a dialog rather than a
    // decorative popover: keyboard users land inside it, not behind it.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const badge = badgeCount(itemCount);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        className={pillClass(itemCount > 0)}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        // The real number, not the truncated bubble: "Cart, 128 items" is
        // useful where "Cart, 99+ items" is not.
        aria-label={badgeLabel("Cart", itemCount)}
      >
        <FontAwesomeIcon icon={faCartShopping} className="text-[14px]" />
        {badge ? (
          <span className="site-nav-utility-badge site-nav-badge" aria-hidden="true">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="fixed left-2 right-2 z-40 mt-2 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur md:absolute md:left-auto md:right-0 md:w-[380px]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
            <h2 id={titleId} className="text-sm font-semibold text-brand-text">
              Your cart
            </h2>
            <span className="text-xs text-brand-textMuted">
              {itemCount} {itemCount === 1 ? "item" : "items"}
            </span>
          </div>

          <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
            {isLoading ? (
              <p className="py-6 text-center text-sm text-brand-textMuted">Loading your cart…</p>
            ) : isError ? (
              <p role="alert" className="ui-notice ui-notice-danger">
                Your cart could not be loaded. Refresh and try again.
              </p>
            ) : !cart?.items.length ? (
              <div className="py-6 text-center">
                <p className="text-sm text-brand-textMuted">Your cart is empty.</p>
                <Link href="/catalog" onClick={() => setOpen(false)} className="ui-btn ui-btn-secondary mt-4">
                  Browse the catalog
                </Link>
              </div>
            ) : (
              <ul className="space-y-3">
                {cart.items.map((item) => (
                  <li key={item.itemId ?? item.productId} className="flex items-start gap-3">
                    {/* Decorative: the product name beside it is the labelled
                        link to the same place, so an empty alt keeps a screen
                        reader from hearing the product twice. */}
                    <Link
                      href={`/catalog/${item.slug}`}
                      onClick={() => setOpen(false)}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="cart-thumb-link"
                    >
                      <ProductImage product={item.image} alt="" sizes="52px" className="cart-thumb cart-thumb-sm" />
                    </Link>

                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/catalog/${item.slug}`}
                        onClick={() => setOpen(false)}
                        className="text-sm font-medium text-brand-text hover:text-brand-primary"
                      >
                        {item.name}
                      </Link>
                      {item.optionLabels.length ? (
                        <p className="mt-0.5 truncate text-xs text-brand-textMuted">
                          {item.optionLabels.map((option) => `${option.group}: ${option.label}`).join(" · ")}
                        </p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-2">
                        <label className="sr-only" htmlFor={`qty-${item.itemId}`}>
                          Quantity for {item.name}
                        </label>
                        <input
                          id={`qty-${item.itemId}`}
                          type="number"
                          min={1}
                          max={99}
                          value={item.quantity}
                          disabled={!item.itemId || setQuantity.isPending}
                          onChange={(event) =>
                            item.itemId &&
                            setQuantity.mutate({ itemId: item.itemId, quantity: Number(event.target.value) })
                          }
                          className="ui-input h-8 w-16 text-sm"
                        />
                        <button
                          type="button"
                          disabled={!item.itemId || remove.isPending}
                          onClick={() => item.itemId && remove.mutate(item.itemId)}
                          className="text-xs text-brand-textMuted underline hover:text-brand-text disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <p className="shrink-0 text-sm font-semibold text-brand-text">
                      {formatCents(item.lineSubtotalCents)}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {hasUnavailable ? (
              <p role="status" className="ui-notice ui-notice-warning mt-3 text-xs">
                {cart?.unavailable.length} item{cart?.unavailable.length === 1 ? "" : "s"} in your cart{" "}
                {cart?.unavailable.length === 1 ? "is" : "are"} no longer available. Open your cart to review.
              </p>
            ) : null}
          </div>

          {cart?.items.length ? (
            <div className="border-t border-zinc-800 px-4 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-brand-textMuted">Subtotal</span>
                <span className="font-semibold text-brand-text">{formatCents(cart.subtotalCents)}</span>
              </div>
              {cart.discountCents > 0 ? (
                <div className="mt-1 flex items-center justify-between text-sm">
                  <span className="text-brand-textMuted">Discount</span>
                  <span className="font-semibold text-emerald-300">−{formatCents(cart.discountCents)}</span>
                </div>
              ) : null}
              <Link href="/cart" onClick={() => setOpen(false)} className="ui-btn ui-btn-primary mt-3 w-full">
                View cart and check out
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
