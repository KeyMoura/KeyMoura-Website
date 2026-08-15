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

import { homeProductFixtures, recentWorkFixtures } from "./fixtures";

/**
 * The homepage, rendered against fixtures.
 *
 * `/` needs Supabase, and this deployment's lockdown gate hides every page
 * client-side before one can be measured, so "does the hero hold together at
 * 900px" was a question that could only be answered by shipping and looking.
 * These are the same components the route renders, given the same prop shapes,
 * so measuring this measures the homepage.
 *
 * Two compositions are rendered, not one:
 *
 *   - the full page in the state it ships in, and
 *   - the empty state — no products, no write-ups — which is what a fresh
 *     install and a catalog outage both look like, and which has to be a
 *     complete page rather than a hero followed by gaps.
 *
 * The route's own `allocateMedia` is not reproduced here; these props are
 * written out so the harness cannot silently drift into testing a different
 * allocation than the page uses. `tests/homepage-3.test.ts` asserts the page
 * and the harness render the same section set.
 */

export function HomeSurfaces() {
  const products = homeProductFixtures;

  return (
    <div data-harness-home="true">
      <section className="page-container-wide" data-surface="home-note">
        <div className="staff-section-head">
          <div className="min-w-0">
            <h2 className="staff-section-title">Homepage</h2>
            <p className="staff-section-description">
              The real sections against fixtures — full width, so section rhythm and the breaks to full bleed can be
              measured rather than inferred. Two products carry media and the rest fall back to the drawn sheet.
            </p>
          </div>
        </div>
      </section>

      <div id="home-full" data-surface="home-full">
        <HomeHero
          lead={products[1] ?? null}
          support={products[0] ?? null}
          leadAlt={products[1]?.name ?? ""}
          supportAlt={products[0]?.name ?? ""}
        />
        <HomeCapabilities media={[products[0] ?? null, products[1] ?? null]} />
        <HomeProductFocus product={products[0] ?? null} />
        <HomeFeaturedProducts products={products.slice(1, 4)} />
        <HomeCustomProject />
        <HomeProcess />
        <HomeMaking />
        <HomeRecentWork items={recentWorkFixtures} />
        <HomeAssurances />
        <HomeFinalCta />
      </div>

      <section className="page-container-wide" data-surface="home-empty-note">
        <div className="staff-section-head">
          <div className="min-w-0">
            <h2 className="staff-section-title">Homepage — nothing to show</h2>
            <p className="staff-section-description">
              No products, no media, no write-ups. Every frame becomes a drawn sheet, the product row states why it is
              empty and offers the custom path, and the recent-work section removes itself instead of leaving a shelf.
            </p>
          </div>
        </div>
      </section>

      <div id="home-bare" data-surface="home-bare">
        <HomeHero lead={null} support={null} leadAlt="" supportAlt="" />
        <HomeCapabilities media={[null, null]} />
        <HomeProductFocus product={null} />
        <HomeFeaturedProducts products={[]} />
        <HomeCustomProject />
        <HomeProcess />
        <HomeMaking />
        <HomeRecentWork items={[]} />
        <HomeAssurances />
        <HomeFinalCta />
      </div>
    </div>
  );
}
