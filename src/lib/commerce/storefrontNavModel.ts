/**
 * The shape of the navbar's category menu, and nothing that can load it.
 *
 * ## Why this is a separate file from `storefrontNav.ts`
 *
 * The loader is `server-only`, which is a real runtime guard and not a hint: it
 * throws at build time if the module reaches a client bundle. `SiteHeader` and
 * `MobileNavDrawer` are client components and need two things from it — the
 * `StorefrontNav` type and an empty value to default their prop to.
 *
 * A type-only import would have been erased, but `EMPTY_STOREFRONT_NAV` is a
 * *value*, so importing it dragged `storefrontNav.ts` — and with it
 * `server-only` and the Supabase server client — into the client graph. The
 * build said so plainly:
 *
 *     'server-only' cannot be imported from a Client Component module.
 *
 * So the shape lives here, where both sides may read it, and the loader stays
 * where only the server can reach it. `storefrontNav.ts` re-exports these names
 * so server callers still need one import.
 */

export type StorefrontNavChild = {
  name: string;
  slug: string;
  href: string;
  count: number;
};

export type StorefrontNavCategory = StorefrontNavChild & {
  children: StorefrontNavChild[];
};

export type StorefrontNav = {
  categories: StorefrontNavCategory[];
  /** Every published product, for the "All products" count. */
  totalCount: number;
};

/**
 * A shop with no categories yet is a valid shop, not an error — and so is a
 * category query that failed. Both render Products as a plain link with no
 * disclosure, which is the correct degraded state: the front door still works.
 */
export const EMPTY_STOREFRONT_NAV: StorefrontNav = { categories: [], totalCount: 0 };
