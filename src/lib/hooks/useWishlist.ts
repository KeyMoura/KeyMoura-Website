"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SerializedCart } from "@/lib/commerce/cartService";
import type { SerializedWishlist } from "@/lib/commerce/wishlistService";
import { CART_QUERY_KEY } from "@/lib/hooks/useCart";

/**
 * The browser's view of the wishlist.
 *
 * Same contract as the cart: every mutation returns the whole re-resolved
 * wishlist and the client renders it. Availability and price annotations are
 * never patched client-side, so a saved item cannot appear buyable here after
 * the server has decided it is not.
 */

export const WISHLIST_QUERY_KEY = ["wishlist"] as const;

export const emptyWishlist: SerializedWishlist = {
  itemCount: 0,
  cartEligibleCount: 0,
  share: null,
  items: [],
};

async function readWishlist(response: Response): Promise<SerializedWishlist> {
  const payload = (await response.json().catch(() => null)) as
    | { wishlist?: SerializedWishlist; error?: string }
    | null;

  if (!response.ok) throw new Error(payload?.error || "Something went wrong with your wishlist.");
  return payload?.wishlist ?? emptyWishlist;
}

export function useWishlist() {
  return useQuery({
    queryKey: WISHLIST_QUERY_KEY,
    queryFn: async () => readWishlist(await fetch("/api/wishlist", { credentials: "same-origin" })),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

export type ShareResult = { token: string; url: string; expiresAt: string | null };

export type MoveResult = {
  moved: number;
  failures: string[];
  cart?: SerializedCart;
  wishlist?: SerializedWishlist;
};

export function useWishlistMutations() {
  const queryClient = useQueryClient();
  const write = (wishlist: SerializedWishlist) => queryClient.setQueryData(WISHLIST_QUERY_KEY, wishlist);

  const add = useMutation({
    mutationFn: async (input: { productId: string; selectedOptions?: Record<string, string> }) =>
      readWishlist(
        await fetch("/api/wishlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            productId: input.productId,
            selectedOptions: input.selectedOptions ?? {},
          }),
        })
      ),
    onSuccess: write,
  });

  const remove = useMutation({
    mutationFn: async (target: { itemId?: string; productId?: string }) => {
      const query = target.itemId
        ? `itemId=${encodeURIComponent(target.itemId)}`
        : `productId=${encodeURIComponent(target.productId ?? "")}`;
      return readWishlist(
        await fetch(`/api/wishlist?${query}`, { method: "DELETE", credentials: "same-origin" })
      );
    },
    onSuccess: write,
  });

  const clear = useMutation({
    mutationFn: async () =>
      readWishlist(await fetch("/api/wishlist", { method: "DELETE", credentials: "same-origin" })),
    onSuccess: write,
  });

  /**
   * Moving touches both collections, so both caches are replaced from the one
   * authoritative response rather than being invalidated and refetched.
   */
  const moveToCart = useMutation({
    mutationFn: async (input: { itemId?: string; all?: boolean; mode: "move" | "copy" }) => {
      const response = await fetch("/api/wishlist/move-to-cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(input),
      });
      const payload = (await response.json().catch(() => null)) as (MoveResult & { error?: string }) | null;
      if (!response.ok) throw new Error(payload?.error || payload?.failures?.[0] || "Could not move that to your cart.");
      return payload as MoveResult;
    },
    onSuccess: (result) => {
      if (result.wishlist) write(result.wishlist);
      if (result.cart) queryClient.setQueryData(CART_QUERY_KEY, result.cart);
    },
  });

  const share = useMutation({
    mutationFn: async (input: { expiresInDays: number | null; rotate?: boolean }) => {
      const response = await fetch("/api/wishlist/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(input),
      });
      const payload = (await response.json().catch(() => null)) as
        | { share?: ShareResult; error?: string }
        | null;
      if (!response.ok || !payload?.share) throw new Error(payload?.error || "Could not create a share link.");
      return payload.share;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY }),
  });

  const revokeShare = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/wishlist/share", { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) throw new Error("Could not turn off sharing.");
      return true;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WISHLIST_QUERY_KEY }),
  });

  return { add, remove, clear, moveToCart, share, revokeShare };
}

/** True when this product is already saved. Drives the toggle's pressed state. */
export function useIsWishlisted(productId: string): boolean {
  const { data } = useWishlist();
  return Boolean(data?.items.some((item) => item.productId === productId));
}
