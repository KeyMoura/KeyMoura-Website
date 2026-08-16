"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import CartDrawer from "@/components/commerce/CartDrawer";

/**
 * Who owns "is the cart drawer open".
 *
 * ## Why this is a provider and not state inside the cart button
 *
 * Two surfaces open the drawer and they are nowhere near each other in the tree:
 * the cart button in the header, and every *Add to cart* button in the catalog
 * and on a product page. The button cannot own the state, because the catalog
 * has no way to reach into the header; the catalog cannot own it either, because
 * the header renders on pages that have no catalog.
 *
 * The provider sits in the root layout, above both, which is the only place
 * that is above both. It also means the drawer is mounted exactly once — the
 * cart button is rendered twice, in the desktop bar and the mobile one, and a
 * drawer per button would give a phone-sized viewport two dialogs racing to
 * lock the same `<body>`.
 *
 * ## Why it is not a window event
 *
 * The site already dispatches `open-command-palette` on `window`, and this could
 * have been a second one of those. Context is used instead because this handoff
 * carries something an event cannot carry cleanly: the element focus has to
 * return to when the drawer closes. Passing a live DOM node through a
 * `CustomEvent` detail works and is a good deal harder to reason about than a
 * function argument, and the caller here already has the node in a ref.
 *
 * ## Focus restoration
 *
 * `openCart` takes the element that asked for it. That is what makes an
 * auto-opened drawer — the one that appears after a successful *Add to cart* —
 * return the customer to the button they pressed in the middle of a product
 * grid, rather than dumping focus at the top of the document and making them
 * find their place in the catalog again.
 *
 * The node is held in a ref rather than in state on purpose: it is not rendered,
 * nothing reads it during render, and storing a DOM node in state would put a
 * detached element in a React value that survives the component that owned it.
 */

type CartDrawerContextValue = {
  open: boolean;
  /** `trigger` is where focus returns when the drawer closes. */
  openCart: (trigger?: HTMLElement | null) => void;
  closeCart: () => void;
};

/**
 * The no-provider default is a working no-op rather than a throw.
 *
 * A missing provider must not be able to take down a product grid — the add
 * itself is a server round-trip that succeeded, and the drawer is confirmation
 * of it. `tests/storefront-polish-4-1.test.ts` asserts the root layout mounts
 * the provider, which is the check that actually catches the mistake.
 */
const CartDrawerContext = createContext<CartDrawerContextValue>({
  open: false,
  openCart: () => {},
  closeCart: () => {},
});

export function useCartDrawer(): CartDrawerContextValue {
  return useContext(CartDrawerContext);
}

export default function CartDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const openCart = useCallback((trigger?: HTMLElement | null) => {
    // A second open from a different button re-points the return focus, which is
    // right: the last thing pressed is the place the customer came from.
    if (trigger) triggerRef.current = trigger;
    setOpen(true);
  }, []);

  const closeCart = useCallback(() => {
    setOpen(false);
    /*
     * Focus goes back to whatever opened it, if that node is still in the
     * document. The check matters for the catalog: a client-side navigation can
     * unmount the *Add to cart* button while its drawer is open, and calling
     * `.focus()` on a detached node silently sends focus to `<body>` — from
     * which Tab restarts at the top of the page.
     */
    const trigger = triggerRef.current;
    triggerRef.current = null;
    if (trigger?.isConnected) trigger.focus();
  }, []);

  const value = useMemo(() => ({ open, openCart, closeCart }), [open, openCart, closeCart]);

  return (
    <CartDrawerContext.Provider value={value}>
      {children}
      <CartDrawer open={open} onClose={closeCart} />
    </CartDrawerContext.Provider>
  );
}
