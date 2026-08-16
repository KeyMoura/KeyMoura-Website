import "server-only";

import { buildBrowseMenu, type BrowseProduct } from "@/lib/commerce/catalogBrowse";
import type { CategoryRow } from "@/lib/commerce/categories";
import {
  EMPTY_STOREFRONT_NAV,
  type StorefrontNav,
  type StorefrontNavCategory,
  type StorefrontNavChild,
} from "@/lib/commerce/storefrontNavModel";
import { supabasePublicServer } from "@/lib/supabasePublicServer";

/**
 * The shop's category hierarchy, for the navigation bar.
 *
 * ## Why this exists rather than a second list of categories
 *
 * The obvious way to give the navbar a Products dropdown is to write the
 * categories into a constant beside `primaryNav`. That is how a site ends up
 * with `catalogCategories`, `navbarCategories` and `mobileCategories` — three
 * hand-maintained hierarchies that agree on the day they are written and never
 * again. Renaming a category in the staff area would fix the catalog rail and
 * leave the navbar pointing at a 404.
 *
 * So there is exactly one hierarchy: `product_categories` in the database. This
 * module reads it and hands it to **`buildBrowseMenu`** — the same function the
 * catalog rail and the mobile filter drawer call, with the same arguments — so
 * the navbar cannot show a category the catalog would not, order them
 * differently, or disagree about a count. `tests/storefront-navigation.test.ts`
 * asserts that property directly rather than trusting this comment.
 *
 * One consequence worth stating, because it looks like a bug and is not: a
 * category with no products in it and no populated subcategories **does not
 * appear**. `buildBrowseMenu` drops those, for the reason recorded there — a
 * menu entry that always opens an empty page costs the same wasted click every
 * visit. The shop has one today ("Shift Knobs", empty), so the dropdown shows
 * Interior without it, exactly as the catalog rail does.
 *
 * ## Cost
 *
 * Two queries, both tiny, both bounded by the catalog rather than by traffic:
 * the category rows, and one column pair per published product for the counts.
 * No media, no descriptions, no prices — the navbar shows none of those.
 *
 * It runs in the root layout, so it is on the path of every page including the
 * staff area. That is affordable at this size and is the reason the select list
 * is as short as it is; if the catalog grows past a few hundred products the
 * counts move to one grouped aggregate and nothing above this changes.
 */

/*
 * The shape lives in `storefrontNavModel.ts` so the client components that
 * render this menu can read it without pulling `server-only` into their
 * bundle. Re-exported here so a server caller still needs one import.
 */
export { EMPTY_STOREFRONT_NAV };
export type { StorefrontNav, StorefrontNavCategory, StorefrontNavChild };

export async function loadStorefrontNav(): Promise<StorefrontNav> {
  try {
    const supabase = supabasePublicServer();

    const [categoryResult, productResult] = await Promise.all([
      supabase
        .from("product_categories")
        .select("id,name,slug,description,parent_id,image_url,display_order,is_active,archived_at")
        .is("archived_at", null)
        .order("display_order"),
      supabase
        .from("products")
        .select("id,name,slug,category_id")
        .eq("is_published", true)
        .is("archived_at", null),
    ]);

    // The navigation bar is on every page. A category outage must cost the
    // dropdown, never the header — Products stays a working link to /catalog
    // whatever happens here, which is the whole point of it remaining a link.
    if (categoryResult.error || productResult.error) return EMPTY_STOREFRONT_NAV;

    const categories = (categoryResult.data ?? []) as CategoryRow[];
    const products = (productResult.data ?? []) as BrowseProduct[];

    const menu = buildBrowseMenu({ categories, products, activeCategoryId: null });

    return {
      totalCount: menu.all.count,
      categories: menu.categories.map((entry) => ({
        name: entry.name,
        slug: entry.slug ?? "",
        href: entry.href,
        count: entry.count,
        children: entry.children.map((child) => ({
          name: child.name,
          slug: child.slug,
          href: child.href,
          count: child.count,
        })),
      })),
    };
  } catch {
    return EMPTY_STOREFRONT_NAV;
  }
}
