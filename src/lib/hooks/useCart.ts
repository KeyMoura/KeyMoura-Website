"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SerializedCart } from "@/lib/commerce/cartService";

/**
 * The browser's view of the cart.
 *
 * Every mutation returns the whole re-resolved cart, so the client never
 * computes a total, never patches one item in place, and never holds a price
 * the server did not just send. That is what keeps the drawer, the cart page,
 * and checkout from ever disagreeing about money.
 */

export const CART_QUERY_KEY = ["cart"] as const;

export const emptyCart: SerializedCart = {
  itemCount: 0,
  subtotalCents: 0,
  discountCents: 0,
  totalCents: 0,
  chargeable: false,
  discount: null,
  items: [],
  unavailable: [],
};

async function readCart(response: Response): Promise<SerializedCart> {
  const payload = (await response.json().catch(() => null)) as
    | { cart?: SerializedCart; error?: string }
    | null;

  if (!response.ok) throw new Error(payload?.error || "Something went wrong with your cart.");
  return payload?.cart ?? emptyCart;
}

export function useCart() {
  return useQuery({
    queryKey: CART_QUERY_KEY,
    queryFn: async () => readCart(await fetch("/api/cart", { credentials: "same-origin" })),
    // The cart is small and correctness matters more than a saved request:
    // a stale total is worse than an extra fetch.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Who the server thinks this visitor is, and whether the shop takes guests.
 *
 * Reads the same endpoint `CheckoutFulfillmentPanel` reads, which is a second
 * GET on the cart page. That is deliberate for now: the panel owns a fair
 * amount of local state around its own copy, and folding the two together is a
 * refactor of a working checkout surface for one saved request. What matters —
 * that both read the *server's* answer rather than the browser's own idea of
 * who is signed in — is already true.
 */
export const CHECKOUT_CONTEXT_QUERY_KEY = ["checkout", "fulfillment"] as const;

export type CheckoutContext = {
  signedIn: boolean;
  guestCheckout: boolean;
  guestRequests: boolean;
};

export function useCheckoutContext() {
  return useQuery({
    queryKey: CHECKOUT_CONTEXT_QUERY_KEY,
    queryFn: async () => {
      const response = await fetch("/api/cart/fulfillment", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not load checkout options.");
      return (await response.json()) as CheckoutContext & Record<string, unknown>;
    },
    staleTime: 30_000,
  });
}

type AddInput = { productId: string; quantity?: number; selectedOptions?: Record<string, string> };

/**
 * All cart writes share one mutation surface so every caller gets the same
 * error handling and the same cache update.
 */
export function useCartMutations() {
  const queryClient = useQueryClient();
  const write = (cart: SerializedCart) => queryClient.setQueryData(CART_QUERY_KEY, cart);

  const add = useMutation({
    mutationFn: async (input: AddInput) =>
      readCart(
        await fetch("/api/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            productId: input.productId,
            quantity: input.quantity ?? 1,
            selectedOptions: input.selectedOptions ?? {},
          }),
        })
      ),
    onSuccess: write,
  });

  const setQuantity = useMutation({
    mutationFn: async (input: { itemId: string; quantity: number }) =>
      readCart(
        await fetch("/api/cart", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(input),
        })
      ),
    onSuccess: write,
  });

  const applyDiscount = useMutation({
    mutationFn: async (discountCode: string | null) =>
      readCart(
        await fetch("/api/cart", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ discountCode }),
        })
      ),
    onSuccess: write,
  });

  const remove = useMutation({
    mutationFn: async (itemId: string) =>
      readCart(
        await fetch(`/api/cart?itemId=${encodeURIComponent(itemId)}`, {
          method: "DELETE",
          credentials: "same-origin",
        })
      ),
    onSuccess: write,
  });

  const clear = useMutation({
    mutationFn: async () => readCart(await fetch("/api/cart", { method: "DELETE", credentials: "same-origin" })),
    onSuccess: write,
  });

  return { add, setQuantity, applyDiscount, remove, clear };
}

export function formatCents(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}
