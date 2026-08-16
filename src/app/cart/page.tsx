"use client";

import Link from "next/link";
import { TermsInlineNotice } from "@/components/legal/TermsNotice";
import { useCallback, useState } from "react";
import ProductImage from "@/components/ProductImage";
import CartSharePanel from "@/components/commerce/CartSharePanel";
import QuantityField from "@/components/commerce/QuantityField";
import CheckoutFulfillmentPanel, {
  type FulfillmentSelection,
  type QuotedTotals,
} from "@/components/commerce/CheckoutFulfillmentPanel";
import { GUEST_ACCESS_WINDOW_LABEL } from "@/lib/commerce/guestAccessWindow";
import { quoteMatchesCart } from "@/lib/commerce/commerceSettings";
import { formatCents, useCart, useCartMutations, useCheckoutContext } from "@/lib/hooks/useCart";

/**
 * The cart page.
 *
 * Every number here comes from the server's last response. The page never adds
 * a line total, never sums a subtotal, and never sends an amount — it renders
 * what `/api/cart` just returned and re-reads it after each change.
 */

export default function CartPage() {
  const { data: cart, isLoading, isError, refetch } = useCart();
  const { setQuantity, remove, clear, applyDiscount } = useCartMutations();
  const [codeInput, setCodeInput] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  /** Which field the server refused, so it can be marked rather than only described. */
  const [checkoutField, setCheckoutField] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [fulfillment, setFulfillment] = useState<FulfillmentSelection | null>(null);
  const [quoted, setQuoted] = useState<QuotedTotals | null>(null);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");

  /**
   * Whether this visitor is signed in, and whether the shop takes guests.
   *
   * Both come from the server. Reading a Supabase session in this component
   * would be a second source of truth about who the visitor is, and the
   * `guest.allowCheckout` switch is the shop's, not the browser's — the
   * checkout route re-checks both, so what is rendered here can only ever
   * remove a control, never grant one.
   */
  const { data: fulfillmentOptions } = useCheckoutContext();
  const signedIn = fulfillmentOptions?.signedIn ?? false;
  const guestAllowed = fulfillmentOptions?.guestCheckout ?? false;

  // Stable identities so the panel's effect does not re-run on every render of
  // this page.
  const handleFulfillmentChange = useCallback((next: FulfillmentSelection | null) => setFulfillment(next), []);
  const handleTotals = useCallback((next: QuotedTotals | null) => setQuoted(next), []);

  /**
   * The quote, but only while it still describes this cart.
   *
   * `quoted` is delivery pricing the server computed for a particular subtotal
   * and discount. Applying a code changes the cart without touching the
   * delivery selection, so the previous quote survives — and reading a Total
   * from it while reading the Discount line from `cart` is exactly how the
   * summary came to show $50.00 on an order Stripe charged $45.00 for. When the
   * basis no longer matches, the page falls back to the cart's own total and
   * says the delivery price is still to come, rather than showing a number it
   * knows is stale.
   */
  const liveQuote = quoteMatchesCart(quoted, cart) ? quoted : null;

  const items = cart?.items ?? [];
  const unavailable = cart?.unavailable ?? [];
  const mutationError =
    setQuantity.error?.message || remove.error?.message || clear.error?.message || applyDiscount.error?.message || "";

  async function startCheckout() {
    setCheckingOut(true);
    setCheckoutError("");
    setCheckoutField(null);
    try {
      const response = await fetch("/api/cart/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // A method id, an address, and — for a guest — where the receipt goes.
        // Never a price: the server recomputes the delivery charge from its own
        // configuration and its own subtotal.
        body: JSON.stringify({
          ...(fulfillment ?? {}),
          ...(signedIn ? {} : { guestEmail, guestName }),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { url?: string; error?: string; field?: string; requiresSignIn?: boolean; shortages?: { productName: string; available: number }[] }
        | null;

      // Only when the shop has guest checkout off. Otherwise a signed-out
      // customer is not sent away from their cart.
      if (payload?.requiresSignIn) {
        window.location.href = `/auth/login?next=${encodeURIComponent("/cart")}`;
        return;
      }
      if (!response.ok || !payload?.url) {
        setCheckoutError(payload?.error || "Checkout could not be started. Please try again.");
        setCheckoutField(payload?.field ?? null);
        // The cart may have changed underneath the customer — a price moved, or
        // something sold out. Re-read it so the page shows why.
        void refetch();
        return;
      }
      window.location.href = payload.url;
    } catch {
      setCheckoutError("Checkout could not be started. Check your connection and try again.");
    } finally {
      setCheckingOut(false);
    }
  }

  if (isLoading) {
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">Your cart</h1>
        <p aria-live="polite" className="mt-6 text-sm text-brand-textMuted">
          Loading your cart…
        </p>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">Your cart</h1>
        <p role="alert" className="ui-notice ui-notice-danger mt-6">
          Your cart could not be loaded.
        </p>
        <button type="button" onClick={() => void refetch()} className="ui-btn ui-btn-secondary mt-4">
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="page-container">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Your cart</h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Prices are confirmed against the live catalog every time this page loads and again at checkout.
        </p>
      </header>

      {mutationError ? (
        <p role="alert" className="ui-notice ui-notice-danger mt-6">
          {mutationError}
        </p>
      ) : null}

      {unavailable.length ? (
        <section aria-labelledby="cart-unavailable" className="ui-notice ui-notice-warning mt-6">
          <h2 id="cart-unavailable" className="font-semibold">
            Some items need attention
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {unavailable.map((entry) => (
              <li key={entry.itemId ?? entry.productId} className="flex flex-wrap items-center gap-2">
                {/* A picture is what makes "this one is out of stock"
                    recognisable at a glance. A deleted product has no media and
                    falls back to the brand mark rather than a broken box. */}
                <ProductImage
                  product={entry.image}
                  alt=""
                  sizes="40px"
                  className="cart-thumb !w-10"
                />
                <span>{entry.message}</span>
                {entry.itemId ? (
                  <button
                    type="button"
                    onClick={() => entry.itemId && remove.mutate(entry.itemId)}
                    className="underline hover:no-underline"
                  >
                    Remove it
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!items.length ? (
        <>
          <div className="ui-empty-state mt-8 !p-10">
            <h2 className="text-xl font-semibold text-brand-text">Your cart is empty.</h2>
            <p className="mt-2">Browse the catalog, or start a custom request if you need something made to order.</p>
            <div className="ui-action-row mt-5 justify-center">
              <Link href="/catalog" className="ui-btn ui-btn-primary">
                Browse the catalog
              </Link>
              <Link href="/orders/new" className="ui-btn ui-btn-secondary">
                Start a custom request
              </Link>
            </div>
          </div>

          {/* Still rendered with an empty cart, because a link shared earlier
              outlives the cart it came from. Hiding this here would make an
              already-public snapshot unrevocable the moment its owner checked
              out or cleared the cart. */}
          <div className="mt-6 max-w-md">
            <CartSharePanel canShare={false} />
          </div>
        </>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
          <section aria-labelledby="cart-items" className="ui-card lg:col-start-1">
            <h2 id="cart-items" className="sr-only">
              Items in your cart
            </h2>
            <ul className="divide-y divide-[var(--border)]">
              {items.map((item) => (
                <li key={item.itemId ?? item.productId} className="flex flex-wrap items-start gap-4 py-4 first:pt-0">
                  {/* Decorative: the heading link beside it points at the same
                      product, so an empty alt avoids announcing it twice. */}
                  <Link
                    href={`/catalog/${item.slug}`}
                    tabIndex={-1}
                    aria-hidden="true"
                    className="cart-thumb-link"
                  >
                    <ProductImage product={item.image} alt="" sizes="64px" className="cart-thumb" />
                  </Link>

                  {/* basis-40 rather than a wider basis: at 320px a 12rem
                      column no longer fits beside the 4rem thumbnail, and the
                      row wraps the text underneath, stranding the image on a
                      line of its own. At 10rem the thumbnail and text stay
                      side by side and the price is what wraps instead. */}
                  <div className="min-w-0 flex-1 basis-40">
                    <h3 className="text-base font-semibold">
                      <Link href={`/catalog/${item.slug}`} className="hover:text-brand-primary">
                        {item.name}
                      </Link>
                    </h3>
                    {item.optionLabels.length ? (
                      <div className="mt-1 text-sm text-brand-textMuted">
                      <p className="font-medium text-brand-text">Configuration</p>
                      <ul>
                        {item.optionLabels.map((option) => (
                          <li key={option.group}>
                            {option.group}: {option.label}
                            {option.adjustmentCents ? ` (${formatCents(option.adjustmentCents)})` : ""}
                          </li>
                        ))}
                      </ul>
                      </div>
                    ) : null}
                    <p className="mt-1 text-sm text-brand-textMuted">Unit: {formatCents(item.unitPriceCents)} · Total: {formatCents(item.lineSubtotalCents)}</p>

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {/* Committed on blur, Enter or a step button — never per
                          keystroke. The old field posted a mutation on every
                          character, so clearing the box asked the server for
                          `quantity: 0` and typing "12" asked for a 1 first. */}
                      <QuantityField
                        id={`cart-qty-${item.itemId}`}
                        value={item.quantity}
                        max={item.maxQuantity ?? null}
                        describedItem={item.name}
                        disabled={!item.itemId || setQuantity.isPending}
                        showMax={false}
                        onCommit={(quantity) =>
                          item.itemId && setQuantity.mutate({ itemId: item.itemId, quantity })
                        }
                      />
                      <button
                        type="button"
                        disabled={!item.itemId || remove.isPending}
                        onClick={() => item.itemId && remove.mutate(item.itemId)}
                        className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <p className="text-lg font-semibold">{formatCents(item.lineSubtotalCents)}</p>
                </li>
              ))}
            </ul>

            <div className="ui-action-row mt-4 justify-between">
              <Link href="/catalog" className="ui-btn ui-btn-ghost text-sm">
                Continue shopping
              </Link>
              <button
                type="button"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
                className="ui-btn ui-btn-ghost text-sm disabled:opacity-50"
              >
                Clear cart
              </button>
            </div>
          </section>

          {/* The summary and the share panel travel together in the second
              column, so the pair sticks as one block rather than the share
              controls scrolling out from under the totals. */}
          <div className="grid gap-6 lg:sticky lg:top-24">
          <aside aria-labelledby="cart-summary" className="ui-card">
            <h2 id="cart-summary" className="text-lg font-semibold">
              Summary
            </h2>

            <div className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-brand-textMuted">Subtotal</span>
                <span className="font-medium">{formatCents(cart?.subtotalCents ?? 0)}</span>
              </div>
              {cart?.discountCents ? (
                <div className="flex items-center justify-between">
                  <span className="text-brand-textMuted">
                    Discount{cart.discount?.ok ? ` (${cart.discount.code})` : ""}
                  </span>
                  <span className="font-medium text-emerald-300">−{formatCents(cart.discountCents)}</span>
                </div>
              ) : null}
              {/* Shipping appears as its own line as soon as the server has
                  priced it, so the customer never has to work out which part of
                  the total was delivery. */}
              {liveQuote ? (
                <div className="flex items-center justify-between">
                  <span className="text-brand-textMuted">Delivery</span>
                  <span className="font-medium">
                    {liveQuote.shippingCents === 0 ? "Free" : formatCents(liveQuote.shippingCents)}
                  </span>
                </div>
              ) : null}
              {liveQuote && liveQuote.taxCents > 0 ? (
                <div className="flex items-center justify-between">
                  <span className="text-brand-textMuted">Tax</span>
                  <span className="font-medium">{formatCents(liveQuote.taxCents)}</span>
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t border-[var(--border)] pt-2 text-base">
                <span className="font-semibold">Total</span>
                <span className="font-semibold">{formatCents(liveQuote?.totalCents ?? cart?.totalCents ?? 0)}</span>
              </div>
              {!liveQuote ? (
                <p className="text-xs text-brand-textMuted">Choose a delivery option to see the final total.</p>
              ) : null}
            </div>

            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault();
                applyDiscount.mutate(codeInput.trim() || null);
              }}
            >
              <label className="text-sm" htmlFor="discount-code">
                Discount code
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  id="discount-code"
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
                  placeholder={cart?.discount?.ok ? cart.discount.code : "Enter a code"}
                  className="ui-input flex-1"
                />
                <button type="submit" disabled={applyDiscount.isPending} className="ui-btn ui-btn-secondary disabled:opacity-50">
                  Apply
                </button>
              </div>
              {cart?.discount && !cart.discount.ok ? (
                <p role="status" className="mt-2 text-xs text-amber-200">
                  {cart.discount.message}
                </p>
              ) : null}
              {cart?.discount?.ok ? (
                <button
                  type="button"
                  onClick={() => {
                    setCodeInput("");
                    applyDiscount.mutate(null);
                  }}
                  className="mt-2 text-xs text-brand-textMuted underline hover:text-brand-text"
                >
                  Remove discount
                </button>
              ) : null}
            </form>

            {checkoutError ? (
              <p role="alert" className="ui-notice ui-notice-danger mt-4 text-sm">
                {checkoutError}
              </p>
            ) : null}

            {/*
              Guest checkout, offered rather than imposed.

              An account is genuinely better — order history, messages,
              cancellations and returns all live there — so signing in is the
              first option and is not buried. What changed is that it is no
              longer the *only* option: a customer who wants to buy one thing
              can, and is told exactly what they give up by doing so.

              The email field only appears for a signed-out visitor, and only
              once the server has said guest checkout is on.
            */}
            {!signedIn && guestAllowed ? (
              <div className="mt-5 grid gap-3 border-t border-brand-border pt-5">
                <p className="text-sm font-semibold">Checking out as a guest</p>
                <label className="text-sm">
                  Email <span className="text-brand-textMuted">(your receipt goes here)</span>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    className="ui-input mt-1 w-full"
                    value={guestEmail}
                    onChange={(event) => setGuestEmail(event.target.value)}
                    aria-invalid={checkoutField === "email" ? true : undefined}
                    placeholder="you@example.com"
                  />
                </label>
                <label className="text-sm">
                  Name <span className="text-brand-textMuted">(optional)</span>
                  <input
                    type="text"
                    autoComplete="name"
                    className="ui-input mt-1 w-full"
                    value={guestName}
                    onChange={(event) => setGuestName(event.target.value)}
                    aria-invalid={checkoutField === "name" ? true : undefined}
                  />
                </label>
                <p className="text-xs text-brand-textMuted">
                  This browser opens the order for {GUEST_ACCESS_WINDOW_LABEL}. After that we email you a 6-digit
                  code.{" "}
                  <Link href={`/auth/login?next=${encodeURIComponent("/cart")}`} className="underline hover:no-underline">
                    Sign in instead
                  </Link>{" "}
                  to keep it in your account with messages, cancellations and returns.
                </p>
              </div>
            ) : null}

            <button
              type="button"
              disabled={!cart?.chargeable || checkingOut || !fulfillment}
              onClick={() => void startCheckout()}
              className="ui-btn ui-btn-primary mt-5 w-full disabled:opacity-50"
            >
              {checkingOut ? "Starting checkout…" : "Check out"}
            </button>
            {!fulfillment ? (
              <p className="mt-2 text-center text-xs text-brand-textMuted">
                Choose a delivery option below to continue.
              </p>
            ) : null}
            {!signedIn && !guestAllowed ? (
              <p className="mt-2 text-center text-xs text-brand-textMuted">
                You will be asked to sign in before paying.
              </p>
            ) : null}

            {/*
              Conspicuous, and immediately below the button it belongs to.

              A footer link is browsewrap and is the weakest form there is; a
              checkbox here would be friction on a purchase of listed goods that
              the Terms already govern. A sentence attached to the action is the
              proportionate middle, and it is where a customer's eye already is.
            */}
            <TermsInlineNotice variant="checkout" className="mt-3 text-center" />
          </aside>

          <CheckoutFulfillmentPanel onChange={handleFulfillmentChange} onTotals={handleTotals} />

          <CartSharePanel canShare={items.length > 0} />
          </div>
        </div>
      )}
    </main>
  );
}
