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

// ---------------------------------------------------------------------------
// The external store
// ---------------------------------------------------------------------------

/**
 * `localStorage` is an external, mutable, browser-only store, so this is
 * exposed as one rather than read into `useState` inside an effect.
 *
 * That is not a lint workaround, it is the thing `useSyncExternalStore` exists
 * for, and it buys two real properties:
 *
 *   1. **No hydration mismatch.** The server snapshot is a stable empty array,
 *      so the strip renders nothing on the server and nothing on the first
 *      client paint, then appears — rather than the server guessing and the
 *      client correcting it under the customer's scroll position.
 *   2. **The recorder and the strip stay in step.** Opening a product writes
 *      the list; every mounted reader is notified and re-renders. Without a
 *      store, the strip on the product page would show yesterday's list until
 *      a reload.
 *
 * `snapshot` is cached deliberately. `getSnapshot` must return a
 * referentially-stable value between changes or React re-renders forever, and
 * parsing JSON on every call would return a fresh array each time.
 */
let snapshot: RecentProduct[] = [];
let snapshotLoaded = false;
const listeners = new Set<() => void>();

/** Stable across calls, so the server and the first client render agree. */
const SERVER_SNAPSHOT: RecentProduct[] = [];

function refresh(): void {
  try {
    snapshot = parseRecentlyViewed(window.localStorage.getItem(RECENTLY_VIEWED_KEY));
  } catch {
    // Private browsing, a disabled storage setting, or a full quota. None of
    // those is a reason to break the page the strip sits on.
    snapshot = [];
  }
  snapshotLoaded = true;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeRecentlyViewed(listener: () => void): () => void {
  listeners.add(listener);
  // A second tab that views a product should update this one's strip.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== RECENTLY_VIEWED_KEY) return;
    refresh();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function recentlyViewedSnapshot(): RecentProduct[] {
  if (!snapshotLoaded) refresh();
  return snapshot;
}

export function recentlyViewedServerSnapshot(): RecentProduct[] {
  return SERVER_SNAPSHOT;
}

export function readRecentlyViewed(): RecentProduct[] {
  if (typeof window === "undefined") return [];
  return recentlyViewedSnapshot();
}

export function rememberRecentProduct(product: RecentProduct): RecentProduct[] {
  if (typeof window === "undefined") return [];
  const next = withRecentProduct(readRecentlyViewed(), product);
  try {
    window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(next));
  } catch {
    // Ignored for the same reason.
  }
  snapshot = next;
  snapshotLoaded = true;
  emit();
  return next;
}

export function clearRecentlyViewed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(RECENTLY_VIEWED_KEY);
  } catch {
    // Ignored for the same reason.
  }
  snapshot = [];
  snapshotLoaded = true;
  emit();
}
