"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * The one piece of state the gallery and the purchase panel share.
 *
 * They are siblings in two different columns of a server component, so there is
 * no prop that can reach from one to the other. The alternatives were to merge
 * them into a single client component — which would drag the whole purchase
 * panel, the wishlist button and the sticky bar into the gallery's file — or to
 * lift the entire product page to the client. A context holding one nullable
 * string is the smallest thing that works.
 *
 * ## Why a token and not just an id
 *
 * "Select Blue" must move the gallery **every time**, including when the
 * customer has since browsed away to another photograph and then re-picks Blue.
 * Storing only the media id makes the second press a no-op, because the id has
 * not changed. The token is a monotonic counter bumped on every request, so the
 * gallery can tell "the same image was asked for again" from "nothing has
 * happened", and manual browsing in between is never fought over.
 *
 * ## Why the default is a no-op rather than a thrown error
 *
 * `ProductGallery` renders in places that have no options at all, and in tests
 * that render it directly. A missing provider means "nothing drives me", which
 * is a legitimate configuration, not a programming mistake.
 */

export type GalleryRequest = { mediaId: string; token: number } | null;

type GalleryContextValue = {
  /** The image an option selection is asking for, with the token that asked. */
  request: GalleryRequest;
  /** Called by the options panel when a chosen value carries an image. */
  showMedia: (mediaId: string) => void;
};

const noop: GalleryContextValue = { request: null, showMedia: () => {} };

const ProductGalleryContext = createContext<GalleryContextValue>(noop);

export function ProductGalleryProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<GalleryRequest>(null);

  const showMedia = useCallback((mediaId: string) => {
    // The counter comes from the previous request rather than a ref, so two
    // selections in the same tick cannot land on the same token.
    setRequest((current) => ({ mediaId, token: (current?.token ?? 0) + 1 }));
  }, []);

  const value = useMemo(() => ({ request, showMedia }), [request, showMedia]);

  return <ProductGalleryContext.Provider value={value}>{children}</ProductGalleryContext.Provider>;
}

export function useProductGallery(): GalleryContextValue {
  return useContext(ProductGalleryContext);
}
