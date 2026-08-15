import type { Metadata } from "next";

import HomeHero from "@/components/home/HomeHero";
import {
  HomeAssurances,
  HomeCapabilities,
  HomeCustomProject,
  HomeFeaturedProducts,
  HomeFinalCta,
  HomeMaking,
  HomeProcess,
  HomeProductFocus,
  HomeRecentWork,
} from "@/components/home/HomeSections";
import type { ProductCardProduct } from "@/components/ProductCard";
import { loadFeaturedProducts } from "@/lib/commerce/catalogData";
import { meta } from "@/lib/home/content";
import { loadRecentWork } from "@/lib/home/recentWork";
import { getSiteSettings } from "@/lib/siteSettings";

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  const title = `${settings.name} | ${meta.titleSuffix}`;

  return {
    title,
    description: meta.description,
    alternates: { canonical: "/" },
    // The root layout sets the site-wide Open Graph card. The homepage restates
    // title and description because it is the URL that actually gets shared,
    // and inheriting "KeyMoura — <tagline>" there would describe the brand
    // rather than what the page offers.
    openGraph: { title, description: meta.description, url: "/" },
    twitter: { title, description: meta.description },
  };
}

/**
 * How the page's few product photographs are shared out.
 *
 * A shop with six published products has to fill a hero, two capability panels,
 * a focus section and a product row without the same photograph appearing twice
 * in adjacent sections — and a shop with one product has to look deliberate too.
 *
 * The rule, in order of prominence:
 *
 *   - The **focus** section takes the first product. It is the largest single
 *     product on the page and the catalog's featured order already says which
 *     product should lead, so this is that product.
 *   - The **row** takes the next three, so nothing in the row repeats the
 *     product shown immediately above it.
 *   - The **hero and panels** rotate over whatever is left, wrapping back to the
 *     start when the catalog is smaller than the page. Wrapping is visible only
 *     on very small catalogs, where the alternative is an empty frame.
 *
 * Every frame degrades to a drawn panel rather than a gap, so a catalog with no
 * photographs at all still renders a complete page. See `HomeMedia`.
 */
function allocateMedia(products: ProductCardProduct[]) {
  const focus = products[0] ?? null;
  const row = products.slice(1, 4);

  const pool = products.slice(1);
  let cursor = 0;
  const next = (): ProductCardProduct | null => {
    if (!pool.length) return products[0] ?? null;
    const item = pool[cursor % pool.length];
    cursor += 1;
    return item ?? null;
  };

  return { focus, row, heroLead: next(), heroSupport: next(), panelA: next(), panelB: next() };
}

export default async function Home() {
  /*
   * Two bounded queries, in parallel, both as the public.
   *
   * The old homepage read through the service-role client, which meant its
   * filters were the only thing standing between a draft product or an
   * unapproved write-up and the front page. Reading as `anon` puts row-level
   * security behind every filter here, and has the side effect of making the
   * homepage's real data path runnable outside production.
   *
   * Neither call can throw the page away: both resolve to an empty list on
   * failure, and every section below renders or removes itself accordingly.
   */
  const [products, work] = await Promise.all([loadFeaturedProducts(6), loadRecentWork(3)]);
  const media = allocateMedia(products);

  return (
    <>
      <HomeHero
        lead={media.heroLead}
        support={media.heroSupport}
        leadAlt={media.heroLead?.name ?? ""}
        supportAlt={media.heroSupport?.name ?? ""}
      />

      <HomeCapabilities media={[media.panelA, media.panelB]} />
      <HomeProductFocus product={media.focus} />
      <HomeFeaturedProducts products={media.row} />
      <HomeCustomProject />
      <HomeProcess />
      <HomeMaking />
      <HomeRecentWork items={work} />
      <HomeAssurances />
      <HomeFinalCta />
    </>
  );
}
