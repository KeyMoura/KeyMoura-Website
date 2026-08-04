"use client";

import { useEffect, useState } from "react";

/**
 * The mobile purchase bar.
 *
 * Below `lg` the purchase actions scroll away above the structured sections,
 * so a customer who reads the specifications has no way to buy without
 * scrolling back. This mirrors the primary action at the bottom of the screen.
 *
 * It hides itself in two situations, both of which matter:
 *
 * 1. **While the real actions are on screen.** Two identical primary buttons
 *    visible at once is a page arguing with itself, and the fixed one covers
 *    the panel it duplicates.
 * 2. **While the request wizard is on screen.** The wizard has its own submit
 *    and its own step buttons; a floating "Request a quote" over the top of
 *    "Continue to delivery" is worse than nothing. This is also what keeps the
 *    bar off the footer, the reviews, and any open accordion at the foot of the
 *    page — they all sit below the wizard.
 *
 * `IntersectionObserver` rather than a scroll handler: it does not run on the
 * main thread per frame, and it reports the state directly instead of
 * recomputing rectangles. The bar starts hidden and is revealed once the
 * observer has something to say, so it never flashes over the panel it is meant
 * to replace during the first paint.
 */
/**
 * The visibility rule, separated from the observer that triggers it.
 *
 * Pure so it can be tested without a browser. That matters more than usual
 * here: `IntersectionObserver` does not deliver callbacks in a pane that is not
 * compositing frames, so automated verification of the *reveal* is not possible
 * in this environment — the rule it would be checking is asserted directly
 * instead.
 *
 * Hidden while any watched anchor is on screen. Fails closed: with no
 * observations at all the bar stays hidden, so a browser that never reports
 * intersection loses a convenience rather than gaining a floating button
 * pinned over the real ones.
 */
export function shouldHideStickyBar(visibleAnchors: number): boolean {
  return visibleAnchors > 0;
}

export default function ProductStickyBar({
  label,
  price,
  href,
  onBuy,
}: {
  label: string;
  price: string | null;
  /** Set for the request path; the bar becomes a link rather than a button. */
  href?: string;
  onBuy?: () => void;
}) {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const watched = [
      document.querySelector(".product-actions"),
      document.querySelector("#request-form"),
    ].filter((node): node is Element => node !== null);

    // No branch for "nothing to watch": the bar is rendered by the purchase
    // panel, so `.product-actions` is always its sibling. If that ever stops
    // being true the bar stays hidden, which is the same fail-closed behaviour
    // as a browser that never reports intersection.
    if (!watched.length) return;

    const visible = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        setHidden(shouldHideStickyBar(visible.size));
      },
      // A sliver counts as visible. Waiting for the whole panel would leave the
      // floating bar sitting over the top half of the buttons it duplicates.
      { threshold: 0 }
    );

    for (const node of watched) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="product-sticky-bar" data-hidden={hidden} aria-hidden={hidden}>
      {price ? <span className="product-sticky-price">{price}</span> : null}
      {href ? (
        <a
          href={href}
          className="ui-btn ui-btn-primary product-sticky-action"
          tabIndex={hidden ? -1 : undefined}
        >
          {label}
        </a>
      ) : (
        <button
          type="button"
          onClick={onBuy}
          className="ui-btn ui-btn-primary product-sticky-action"
          tabIndex={hidden ? -1 : undefined}
        >
          {label}
        </button>
      )}
    </div>
  );
}
