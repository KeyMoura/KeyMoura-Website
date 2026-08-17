import { NextRequest, NextResponse } from "next/server";
import {
  normalizeSuggestQuery,
  rankCategorySuggestions,
  SUGGEST_LIMITS,
  type SuggestProject,
  type SuggestResponse,
} from "@/lib/commerce/catalogSuggest";
import { loadStorefrontNav } from "@/lib/commerce/storefrontNav";
import { buildSearchScopes, resolveScope, scopeCategorySlug, scopeGroups } from "@/lib/commerce/searchScopes";
import { catalogPriceLabel } from "@/lib/commerce/catalogActions";
import { productImageCandidates } from "@/lib/productImages";
import { supabasePublicServer } from "@/lib/supabasePublicServer";

/**
 * Suggestions for the storefront search box.
 *
 * ## What this deliberately is not
 *
 * It is not a search engine, and it is not the command palette. The palette
 * pulls 300 projects, 500 forum threads and 200 products into the browser on
 * open and ranks them client-side — a reasonable design for a site-wide
 * navigator and a bad one for a shop's search box, where the answer is wanted
 * in a few hundred milliseconds after every keystroke.
 *
 * This is a bounded server lookup: at most five products, three categories and
 * four projects, matched in the database rather than in the customer's tab.
 * Typing never fetches the catalog.
 *
 * ## What it may return
 *
 * The **public** columns of **published** products and **approved** projects,
 * and nothing else. It reads through the anon key, so RLS is a second,
 * independent guard behind the filters: a mistake in a `.eq()` here returns
 * nothing rather than leaking a draft. Cost, inventory counts, internal notes,
 * staff fields, unpublished and archived rows are not selected and could not be
 * read if they were. A project that is not `approved` is not selected, and the
 * same policy that keeps it off `/projects` keeps it out of this.
 *
 * ## Scope
 *
 * `scope` names one of the entries `buildSearchScopes` derives from the same
 * navigation the Products dropdown is drawn from, so a scope this route accepts
 * is a scope that exists. An unknown or absent one resolves to All rather than
 * erroring — a stale bookmark should widen the search, not break it.
 *
 * Which groups a scope may return is decided by `scopeGroups` and not restated
 * here, so the route and the panel cannot disagree about what "scoped" means.
 * The work for a group that is switched off is not merely filtered afterwards:
 * the query is not issued at all, which is what makes a Projects-scoped search
 * cost one round trip instead of three.
 *
 * ## Matching
 *
 * `ilike` on the name, the short description and the denormalized category name
 * for products; on the title and slug for projects. Case and surrounding
 * whitespace are normalized, and a hyphen matches a space so "shift-knob" finds
 * "Shift Knob" — the whole of the typo tolerance this pass takes on. Anything
 * fuzzier is a trigram index and a ranking function, which is a project rather
 * than a phase; it is written down as deferred rather than half-built.
 */

export const revalidate = 60;

type SuggestProductRow = {
  id: string;
  name: string;
  slug: string;
  short_description: string | null;
  category: string | null;
  image_url: string | null;
  purchase_mode: string | null;
  starting_price_cents: number | null;
  availability_status: string | null;
  product_media: { url: string | null; kind: string | null; sort_order: number | null }[] | null;
};

type ProjectRow = { id: string; title: string; slug: string };

const empty = (query: string, scope: string, error?: boolean): SuggestResponse => ({
  query,
  scope,
  products: [],
  categories: [],
  projects: [],
  ...(error ? { error: true } : {}),
});

export async function GET(req: NextRequest) {
  const query = normalizeSuggestQuery(req.nextUrl.searchParams.get("q"));
  const requestedScope = req.nextUrl.searchParams.get("scope") ?? "all";

  // Nothing worth a round trip. Two characters is where a prefix stops naming
  // a product and starts naming most of the catalog.
  if (query.length < SUGGEST_LIMITS.minQueryLength) {
    return NextResponse.json(empty(query, requestedScope));
  }

  try {
    const supabase = supabasePublicServer();
    const pattern = `%${query.replace(/[%_]/g, (match) => `\\${match}`)}%`;

    /*
     * The nav is loaded whatever the scope, because it is what *validates* the
     * scope — resolving an id against the real category tree is how an
     * invented `category:anything` becomes All rather than an unfiltered query.
     * It is a cached read of two small tables and is already on the path of
     * every page render.
     */
    const nav = await loadStorefrontNav();
    const scope = resolveScope(buildSearchScopes(nav), requestedScope);
    const groups = scopeGroups(scope);
    const categorySlug = scopeCategorySlug(scope.id);

    /*
     * A category scope constrains by id, not by the denormalized `category`
     * name on the product row. The name is a label and two categories may
     * share one; `category_id` is the thing the catalog itself counts and
     * filters by, so scoping on anything else would put a different set of
     * products in the suggestions than on the page the suggestion leads to.
     */
    let categoryIds: string[] | null = null;
    if (groups.products && categorySlug) {
      const { data: rows } = await supabase
        .from("product_categories")
        .select("id,slug,parent_id")
        .is("archived_at", null);
      const all = (rows ?? []) as { id: string; slug: string; parent_id: string | null }[];
      const root = all.find((row) => row.slug === categorySlug);
      // A slug that resolves to no row cannot be searched "within", and
      // widening to the whole catalog would silently ignore the scope. An
      // empty id list returns nothing, which is the honest answer.
      categoryIds = root ? [root.id, ...all.filter((row) => row.parent_id === root.id).map((row) => row.id)] : [];
    }

    const productQuery = groups.products
      ? (() => {
          let builder = supabase
            .from("products")
            .select(
              "id,name,slug,short_description,category,image_url,purchase_mode,starting_price_cents,availability_status,product_media(url,kind,sort_order)"
            )
            .eq("is_published", true)
            .is("archived_at", null)
            .or(`name.ilike.${pattern},short_description.ilike.${pattern},category.ilike.${pattern}`);
          if (categoryIds) builder = builder.in("category_id", categoryIds);
          return builder.order("sort_order").limit(SUGGEST_LIMITS.products);
        })()
      : null;

    const projectQuery = groups.projects
      ? supabase
          .from("info_pages")
          .select("id,title,slug")
          .eq("status", "approved")
          .or(`title.ilike.${pattern},slug.ilike.${pattern}`)
          .order("updated_at", { ascending: false })
          .limit(SUGGEST_LIMITS.projects)
      : null;

    const [productResult, projectResult] = await Promise.all([productQuery, projectQuery]);

    // A failure in one group empties that group rather than the whole panel:
    // a projects outage should not take the products with it.
    const productRows = (productResult?.error ? [] : ((productResult?.data ?? []) as SuggestProductRow[]));
    const projectRows = (projectResult?.error ? [] : ((projectResult?.data ?? []) as ProjectRow[]));

    const response: SuggestResponse = {
      query,
      scope: scope.id,
      products: productRows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        category: row.category,
        image: productImageCandidates(row)[0] ?? null,
        // The same wording the card uses, from the same function, so a
        // suggestion cannot quote a price the catalog would phrase differently.
        price: catalogPriceLabel(row),
      })),
      categories: groups.categories
        ? rankCategorySuggestions(nav.categories, query, categorySlug)
        : [],
      projects: projectRows.map((row): SuggestProject => ({ id: row.id, title: row.title, slug: row.slug })),
    };

    return NextResponse.json(response);
  } catch {
    return NextResponse.json(empty(query, requestedScope, true), { status: 200 });
  }
}
