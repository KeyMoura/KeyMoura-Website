/**
 * Recently viewed products.
 *
 * ## Why this never reaches the server
 *
 * The shop already knows a great deal about a customer who is signed in, and it
 * has a legitimate reason for each piece: an order needs an address, a cart
 * needs items, a wishlist is a thing the customer deliberately saved. Browsing
 * history is none of those. It is behavioural data whose only purpose is a
 * convenience strip at the bottom of a page, and the honest way to hold it is
 * on the device that produced it, where the customer can clear it themselves
 * and it is never joined to an identity.
 *
 * So: `localStorage`, bounded to six entries, ids and display text only, no
 * timestamps beyond ordering, no account association, and no network call. It
 * is classified in the storage audit as functional/preference, which is what it
 * genuinely is — and it is why this pass adds no analytics cookie and no
 * tracking to go with it.
 *
 * Pure and dependency-free apart from the storage calls themselves, so the
 * bounding and de-duplication rules are directly testable.
 */

export const RECENTLY_VIEWED_KEY = "km.catalog.recent";

/**
 * Six.
 *
 * Enough to hold a comparison a customer is actually making, few enough that
 * the strip stays one row on a laptop and does not become a second catalog
 * competing with the real one below it.
 */
export const RECENTLY_VIEWED_LIMIT = 6;

export type RecentProduct = {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  price: string;
};

/** Anything unparseable is no history rather than a thrown error. */
export function parseRecentlyViewed(raw: string | null): RecentProduct[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Partial<RecentProduct>;
      if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.slug !== "string") {
        return [];
      }
      return [
        {
          id: value.id,
          name: value.name,
          slug: value.slug,
          image: typeof value.image === "string" ? value.image : null,
          price: typeof value.price === "string" ? value.price : "",
        },
      ];
    }).slice(0, RECENTLY_VIEWED_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The list after viewing `product`, most recent first.
 *
 * Re-viewing something moves it to the front rather than adding a duplicate,
 * which is what stops a customer who reloads one product page six times from
 * having a history consisting entirely of that product.
 */
export function withRecentProduct(
  current: readonly RecentProduct[],
  product: RecentProduct
): RecentProduct[] {
  return [product, ...current.filter((entry) => entry.id !== product.id)].slice(0, RECENTLY_VIEWED_LIMIT);
}

export function readRecentlyViewed(): RecentProduct[] {
  if (typeof window === "undefined") return [];
  try {
    return parseRecentlyViewed(window.localStorage.getItem(RECENTLY_VIEWED_KEY));
  } catch {
    // Private browsing, a disabled storage setting, or a full quota. None of
    // those is a reason to break the page the strip sits on.
    return [];
  }
}

export function rememberRecentProduct(product: RecentProduct): RecentProduct[] {
  if (typeof window === "undefined") return [];
  const next = withRecentProduct(readRecentlyViewed(), product);
  try {
    window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(next));
  } catch {
    // Ignored for the same reason.
  }
  return next;
}

export function clearRecentlyViewed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RECENTLY_VIEWED_KEY);
  } catch {
    // Ignored for the same reason.
  }
}
