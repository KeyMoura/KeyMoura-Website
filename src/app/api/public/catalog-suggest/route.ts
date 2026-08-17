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
import { rankCandidates } from "@/lib/search/relevance";
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
 * ## Matching, in two phases
 *
 * **Recall** happens in Postgres. `ilike` on the name, the short description
 * and the denormalized category name for products; on the title, the slug and
 * the tags for projects. That is the precise path, and it is the one that will
 * use a trigram index the moment one exists (see `docs/search-architecture.md`
 * — the index products need is a migration, and this pass does not apply it).
 *
 * **Ranking** happens in `@/lib/search/relevance`, over the rows recall
 * returned. Until this pass there was none: whatever `ilike` matched came back
 * in `sort_order`, so "shift knob" returned the catalog's first five products in
 * catalog order. Now an exact name beats a prefix beats a category hit beats a
 * description mention, and a typo is tolerated in a tier strictly below all of
 * them.
 *
 * **Fuzzy recall** is a second, narrower query, and only when the precise one
 * came back thin. Postgres cannot answer "near this word" without the index, so
 * the fallback pulls a bounded page of the scope's rows and lets the ranker
 * decide. It is capped at `FUZZY_RECALL_LIMIT`, gated on a query long enough for
 * a near miss to mean something, and skipped entirely when the precise phase
 * already filled the panel — so the common case costs exactly what it did
 * before. `docs/search-architecture.md` records where that cap starts to bite
 * and the migration that removes it.
 */

export const revalidate = 60;

/**
 * The ceiling on the typo-tolerance fallback.
 *
 * Without a trigram index there is no way to ask Postgres for near misses, so
 * the fallback reads rows and ranks them here. 200 is comfortably the whole
 * published catalog today and stays a bounded, indexed read (`products_public_
 * order_idx`) rather than an unbounded scan. Past that it stops being complete
 * — which is the scaling cliff the proposed migration removes, and is recorded
 * rather than hidden.
 */
const FUZZY_RECALL_LIMIT = 200;

/** Below this, a near miss is a different word rather than a typo. */
const MIN_FUZZY_QUERY_LENGTH = 4;

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

type ProjectRow = {
  id: string;
  title: string;
  slug: string;
  tags: string[] | null;
  category: string | null;
  updated_at: string | null;
};

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

    const PRODUCT_COLUMNS =
      "id,name,slug,short_description,category,image_url,purchase_mode,starting_price_cents,availability_status,product_media(url,kind,sort_order)";

    /*
     * The scope is applied to the *candidate query*, not to the ranked output.
     *
     * That is the brief's rule that a category scope must constrain candidates
     * before or while ranking rather than ranking everything and hiding the
     * wrong categories afterwards — and it is also the only version that is
     * correct, because a post-filter would let five out-of-scope products
     * consume the five suggestion slots and return an empty panel.
     */
    const scopedProducts = (limit: number) => {
      let builder = supabase
        .from("products")
        .select(PRODUCT_COLUMNS)
        .eq("is_published", true)
        .is("archived_at", null);
      if (categoryIds) builder = builder.in("category_id", categoryIds);
      return builder.order("sort_order").limit(limit);
    };

    const productQuery = groups.products
      ? scopedProducts(FUZZY_RECALL_LIMIT).or(
          `name.ilike.${pattern},short_description.ilike.${pattern},category.ilike.${pattern}`
        )
      : null;

    const projectQuery = groups.projects
      ? supabase
          .from("info_pages")
          .select("id,title,slug,tags,category,updated_at")
          .eq("status", "approved")
          .or(`title.ilike.${pattern},slug.ilike.${pattern}`)
          .order("updated_at", { ascending: false })
          .limit(FUZZY_RECALL_LIMIT)
      : null;

    const [productResult, projectResult] = await Promise.all([productQuery, projectQuery]);

    // A failure in one group empties that group rather than the whole panel:
    // a projects outage should not take the products with it.
    const productRows: SuggestProductRow[] = productResult?.error
      ? []
      : [...((productResult?.data ?? []) as SuggestProductRow[])];
    const projectRows: ProjectRow[] = projectResult?.error
      ? []
      : [...((projectResult?.data ?? []) as ProjectRow[])];

    /*
     * The typo pass.
     *
     * Only when the precise query came back thin, and only for a query long
     * enough that a near miss is a typo rather than a different word. Without a
     * trigram index there is nothing to ask Postgres, so this reads a bounded
     * page of the scope and lets `rankCandidates` decide — a near miss lands in
     * the `fuzzy` tier, strictly below every literal match, so widening recall
     * cannot displace a real answer.
     */
    const wantsFuzzy = query.length >= MIN_FUZZY_QUERY_LENGTH;

    if (groups.products && wantsFuzzy && productRows.length < SUGGEST_LIMITS.products) {
      const { data, error } = await scopedProducts(FUZZY_RECALL_LIMIT);
      if (!error && data) {
        const seen = new Set(productRows.map((row) => row.id));
        for (const row of data as SuggestProductRow[]) if (!seen.has(row.id)) productRows.push(row);
      }
    }

    if (groups.projects && wantsFuzzy && projectRows.length < SUGGEST_LIMITS.projects) {
      const { data, error } = await supabase
        .from("info_pages")
        .select("id,title,slug,tags,category,updated_at")
        .eq("status", "approved")
        .order("updated_at", { ascending: false })
        .limit(FUZZY_RECALL_LIMIT);
      if (!error && data) {
        const seen = new Set(projectRows.map((row) => row.id));
        for (const row of data as ProjectRow[]) if (!seen.has(row.id)) projectRows.push(row);
      }
    }

    /*
     * Ranking, and only now the cut to five and four.
     *
     * The candidate lists above are recall; these are the answers. Slicing
     * before ranking is what the previous version effectively did by taking
     * `limit(5)` in `sort_order`, and it is why the best match for a query was
     * routinely absent from a panel that had room for it.
     */
    const rankedProducts = rankCandidates(
      productRows.map((row) => ({
        id: row.id,
        title: row.name,
        // The category is the curated term this catalog files a product under,
        // so it is a tag rather than body text — the weighting that makes
        // "shift knob" prefer the Shift Knobs shelf to a passing mention.
        tags: row.category ? [row.category] : [],
        slug: row.slug,
        body: row.short_description,
        row,
      })),
      query
    ).slice(0, SUGGEST_LIMITS.products);

    const rankedProjects = rankCandidates(
      projectRows.map((row) => ({
        id: row.id,
        title: row.title,
        tags: [...(row.tags ?? []), row.category ?? ""].filter(Boolean),
        slug: row.slug,
        body: null,
        updatedAt: row.updated_at ?? null,
        row,
      })),
      query
    ).slice(0, SUGGEST_LIMITS.projects);

    const response: SuggestResponse = {
      query,
      scope: scope.id,
      products: rankedProducts.map(({ candidate }) => ({
        id: candidate.row.id,
        name: candidate.row.name,
        slug: candidate.row.slug,
        category: candidate.row.category,
        image: productImageCandidates(candidate.row)[0] ?? null,
        // The same wording the card uses, from the same function, so a
        // suggestion cannot quote a price the catalog would phrase differently.
        price: catalogPriceLabel(candidate.row),
      })),
      categories: groups.categories
        ? rankCategorySuggestions(nav.categories, query, categorySlug)
        : [],
      projects: rankedProjects.map(({ candidate }): SuggestProject => ({
        id: candidate.row.id,
        title: candidate.row.title,
        slug: candidate.row.slug,
      })),
    };

    return NextResponse.json(response);
  } catch {
    return NextResponse.json(empty(query, requestedScope, true), { status: 200 });
  }
}
