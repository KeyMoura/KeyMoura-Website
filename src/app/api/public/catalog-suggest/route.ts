import { NextRequest, NextResponse } from "next/server";
import { normalizeSuggestQuery, rankCategorySuggestions, SUGGEST_LIMITS } from "@/lib/commerce/catalogSuggest";
import { loadStorefrontNav } from "@/lib/commerce/storefrontNav";
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
 * This is a bounded server lookup: at most five products and three categories,
 * one round trip, matched in the database rather than in the customer's tab.
 * Typing never fetches the catalog.
 *
 * ## What it may return
 *
 * The **public** columns of **published** products, and nothing else. It reads
 * through the anon key, so RLS is a second, independent guard behind the
 * filters: a mistake in a `.eq()` here returns nothing rather than leaking a
 * draft. Cost, inventory counts, internal notes, staff fields, unpublished and
 * archived rows are not selected and could not be read if they were.
 *
 * ## Matching
 *
 * `ilike` on the name, the short description and the denormalized category
 * name. Case and surrounding whitespace are normalized, and a hyphen matches a
 * space so "shift-knob" finds "Shift Knob" — the whole of the typo tolerance
 * this pass takes on. Anything fuzzier is a trigram index and a ranking
 * function, which is a project rather than a phase; it is written down as
 * deferred rather than half-built.
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

export async function GET(req: NextRequest) {
  const query = normalizeSuggestQuery(req.nextUrl.searchParams.get("q"));

  // Nothing worth a round trip. Two characters is where a prefix stops naming
  // a product and starts naming most of the catalog.
  if (query.length < SUGGEST_LIMITS.minQueryLength) {
    return NextResponse.json({ query, products: [], categories: [] });
  }

  try {
    const supabase = supabasePublicServer();
    const pattern = `%${query.replace(/[%_]/g, (match) => `\\${match}`)}%`;

    const [productResult, nav] = await Promise.all([
      supabase
        .from("products")
        .select(
          "id,name,slug,short_description,category,image_url,purchase_mode,starting_price_cents,availability_status,product_media(url,kind,sort_order)"
        )
        .eq("is_published", true)
        .is("archived_at", null)
        .or(`name.ilike.${pattern},short_description.ilike.${pattern},category.ilike.${pattern}`)
        .order("sort_order")
        .limit(SUGGEST_LIMITS.products),
      loadStorefrontNav(),
    ]);

    if (productResult.error) {
      return NextResponse.json({ query, products: [], categories: [], error: true }, { status: 200 });
    }

    const rows = (productResult.data ?? []) as SuggestProductRow[];

    return NextResponse.json({
      query,
      products: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        category: row.category,
        image: productImageCandidates(row)[0] ?? null,
        // The same wording the card uses, from the same function, so a
        // suggestion cannot quote a price the catalog would phrase differently.
        price: catalogPriceLabel(row),
      })),
      categories: rankCategorySuggestions(nav.categories, query),
    });
  } catch {
    return NextResponse.json({ query, products: [], categories: [], error: true }, { status: 200 });
  }
}
