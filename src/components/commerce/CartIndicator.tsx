"use client";

import { useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCartShopping } from "@fortawesome/free-solid-svg-icons";
import { useCartDrawer } from "@/components/commerce/CartDrawerProvider";
import { badgeCount, badgeLabel } from "@/lib/navBadge";
import { useCart } from "@/lib/hooks/useCart";

/**
 * The navbar cart button.
 *
 * It used to be the button *and* the panel. The panel is now `CartDrawer`,
 * mounted once by `CartDrawerProvider` in the root layout, and this component
 * kept only the two jobs that genuinely belong to a header control: show how
 * many things are in the cart, and open it.
 *
 * That split is not cosmetic. This component is rendered twice — once in the
 * desktop bar, once in the mobile one — so when it owned the panel there were
 * two dialogs in the document, each with its own focus trap and each trying to
 * lock `<body>` scrolling. Only one was ever visible, which is precisely why the
 * duplication survived as long as it did.
 *
 * Uses the dedicated navbar utility colors rather than theme colors, matching
 * the notification bell beside it, so Appearance keeps full control of the
 * navbar without this control drifting from its neighbours.
 *
 * `aria-haspopup="dialog"` and `aria-expanded` still describe it accurately: the
 * dialog it opens lives elsewhere in the DOM, which is exactly what those
 * attributes are for.
 *
 * `site-nav-count-host` is what the count bubble is positioned against, and its
 * absence here is the whole of the misplaced-cart-badge defect: this button
 * carried no `position`, so the bubble resolved against the sticky header and
 * landed in the corner of the bar. See the class's own comment in globals.css.
 */

const pillClass = (highlighted: boolean) =>
  `site-nav-count-host inline-flex h-9 w-9 items-center justify-center rounded-full border text-sm site-nav-utility${
    highlighted ? " is-highlighted" : ""
  }`;

export default function CartIndicator() {
  const { data: cart } = useCart();
  const { open, openCart } = useCartDrawer();
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const itemCount = cart?.itemCount ?? 0;
  const badge = badgeCount(itemCount);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={pillClass(itemCount > 0)}
      // The button hands the drawer its own node, so Escape or Close returns the
      // customer to this control rather than to the top of the document.
      onClick={() => openCart(buttonRef.current)}
      aria-expanded={open}
      aria-haspopup="dialog"
      // The real number, not the truncated bubble: "Cart, 128 items" is
      // useful where "Cart, 99+ items" is not.
      aria-label={badgeLabel("Cart", itemCount)}
      data-testid="cart-indicator"
    >
      <FontAwesomeIcon icon={faCartShopping} className="text-[14px]" />
      {badge ? (
        <span className="site-nav-utility-badge site-nav-badge" aria-hidden="true">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
