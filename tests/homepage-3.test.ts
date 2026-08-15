import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import HomeHero from "../src/components/home/HomeHero.tsx";
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
} from "../src/components/home/HomeSections.tsx";
import type { ProductCardProduct } from "../src/components/ProductCard.tsx";
import * as content from "../src/lib/home/content.ts";

/**
 * Homepage 3.0.
 *
 * The homepage is the one page whose job is not a feature — it is a claim about
 * a business — so these tests are split between two kinds of assertion:
 *
 *   - **Structure**, checked against real rendered markup: one `h1`, both doors
 *     reachable, canonical product and project links, headings that nest.
 *   - **Restraint**, checked against source: that the page loads a bounded set
 *     as the public, that it does not grow a second catalog, that its copy
 *     invents no facts, and that no colour on it escapes the appearance system.
 *
 * The second kind is what a homepage actually regresses on. A layout mistake is
 * visible; "someone added a fake review count" and "the featured row started
 * fetching the whole catalog" are not.
 */

// Newlines normalized: this repository checks out CRLF on Windows, and an
// assertion that happens to anchor on "\n" then passes or fails depending on
// which machine ran it.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const page = read("src/app/page.tsx");
const heroSource = read("src/components/home/HomeHero.tsx");
const sectionsSource = read("src/components/home/HomeSections.tsx");
const mediaSource = read("src/components/home/HomeMedia.tsx");
const recentWorkSource = read("src/lib/home/recentWork.ts");
const catalogData = read("src/lib/commerce/catalogData.ts");
const contentSource = read("src/lib/home/content.ts");
const globalsCss = read("src/app/globals.css");
const harness = read("src/app/dev/visual/homeSurfaces.tsx");
const layout = read("src/app/layout.tsx");

/** Just the homepage's own rules, so assertions cannot be satisfied elsewhere. */
const homeCss = (() => {
  const start = globalsCss.indexOf("   * Homepage");
  const end = globalsCss.indexOf("/* Product cards:", start);
  assert.ok(start > -1 && end > start, "the homepage CSS block must be locatable");
  return globalsCss.slice(start, end);
})();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const product: ProductCardProduct = {
  id: "p1",
  name: "Billet Shift Knob",
  slug: "billet-shift-knob",
  short_description: "Turned from 6061 aluminum.",
  image_url: null,
  category: "Interior",
  starting_price_cents: 8400,
  is_custom: false,
  purchase_mode: "direct_purchase",
  availability_status: "available",
  lead_time_text: null,
  inventory_policy: "unlimited",
  inventory_quantity: 0,
  continue_selling_when_out_of_stock: false,
  product_media: null,
};

const quoteOnly: ProductCardProduct = {
  ...product,
  id: "p2",
  name: "Custom Bracket",
  slug: "custom-bracket",
  starting_price_cents: null,
  purchase_mode: "request_only",
};

const work = [
  { id: "w1", title: "Rebuilding a seized indexer", slug: "seized-indexer", category: "CNC & Machining", updated_at: "2026-07-28T12:00:00.000Z" },
];

/** The whole page, as the route composes it. */
function renderHome({ products = [product, quoteOnly], items = work } = {}) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(HomeHero, { lead: products[0] ?? null, support: products[1] ?? null, leadAlt: products[0]?.name ?? "", supportAlt: products[1]?.name ?? "" }),
      createElement(HomeCapabilities, { media: [products[0] ?? null, products[1] ?? null] }),
      createElement(HomeProductFocus, { product: products[0] ?? null }),
      createElement(HomeFeaturedProducts, { products }),
      createElement(HomeCustomProject, {}),
      createElement(HomeProcess, {}),
      createElement(HomeMaking, {}),
      createElement(HomeRecentWork, { items }),
      createElement(HomeAssurances, {}),
      createElement(HomeFinalCta, {})
    )
  );
}

const markup = renderHome();
const bare = renderHome({ products: [], items: [] });

// ---------------------------------------------------------------------------
// The hero, and the two doors
// ---------------------------------------------------------------------------

test("the page has exactly one h1, and it is the hero headline", () => {
  const h1s = markup.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) ?? [];
  assert.equal(h1s.length, 1);
  assert.match(h1s[0]!, /home-hero-title/);
  assert.match(h1s[0]!, /parts that don&#x27;t exist yet|parts that don't exist yet/);
  // "Welcome to KeyMoura" and friends: a headline that says nothing.
  assert.doesNotMatch(h1s[0]!, /welcome/i);
});

test("the hero offers a shop door and a custom door, and only one primary", () => {
  const hero = markup.slice(0, markup.indexOf("home-hero-foot"));
  // React emits className before href, so match the whole tag rather than a
  // fixed attribute order.
  const anchors = [...hero.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1]!);
  const roleFor = (href: string) => anchors.find((attrs) => attrs.includes(`href="${href}"`)) ?? "";
  assert.match(roleFor("/catalog"), /ui-btn-primary/, "Shop products must be the primary action");
  assert.match(roleFor("/orders/new"), /ui-btn-secondary/, "Start a custom project must be the secondary action");
  assert.equal((hero.match(/ui-btn-primary/g) ?? []).length, 1, "one primary action in the hero");
});

test("both doors are offered again without being repeated in every section", () => {
  const shop = (markup.match(/href="\/catalog"/g) ?? []).length;
  const custom = (markup.match(/href="\/orders\/new"/g) ?? []).length;
  assert.ok(shop >= 2, "the shop must be reachable from more than the hero");
  assert.ok(custom >= 2, "custom work must be reachable from more than the hero");
  assert.ok(custom <= 6, `custom CTA appears ${custom} times — that is spam, not emphasis`);
});

test("the closing section is a real landing, not a trailing product grid", () => {
  const close = markup.slice(markup.indexOf("home-close"));
  assert.match(close, /home-close-title/);
  assert.match(close, /href="\/orders\/new"/);
  assert.match(close, /href="\/catalog"/);
});

// ---------------------------------------------------------------------------
// Semantics and accessibility
// ---------------------------------------------------------------------------

test("headings nest without skipping a level", () => {
  const levels = [...markup.matchAll(/<h([1-3])[\s>]/g)].map((m) => Number(m[1]));
  assert.ok(levels.length > 8, "the page should have a real heading outline");
  assert.equal(levels[0], 1, "the outline starts at the h1");
  for (let i = 1; i < levels.length; i += 1) {
    assert.ok(levels[i]! - levels[i - 1]! <= 1, `heading level jumped from h${levels[i - 1]} to h${levels[i]}`);
  }
});

test("every section is labelled by a heading it actually contains", () => {
  for (const id of [...markup.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1])) {
    assert.match(markup, new RegExp(`id="${id}"`), `aria-labelledby="${id}" points at nothing`);
  }
});

test("the eyebrow above the headline is not a heading", () => {
  // A label like "Custom routing & light machining" marked up as a heading puts
  // a category name into the outline ahead of the page's own title.
  assert.match(heroSource, /<p className="home-eyebrow">/);
  assert.doesNotMatch(heroSource, /<h[1-6][^>]*className="home-eyebrow"/);
});

test("the drawn media panel is decorative and never announced", () => {
  assert.match(mediaSource, /className="home-media-sheet" aria-hidden="true"/);
  // Its brand mark must not become an image with a meaningless alt text.
  assert.doesNotMatch(mediaSource, /alt="KM"/);
});

test("decorative washes and rules are hidden from assistive technology", () => {
  for (const cls of ["home-hero-wash", "home-hero-rules", "home-custom-wash", "home-close-wash", "home-process-rail"]) {
    const rendered = new RegExp(`class="[^"]*${cls}[^"]*"[^>]*aria-hidden="true"`);
    assert.match(markup, rendered, `${cls} must be aria-hidden`);
  }
});

// ---------------------------------------------------------------------------
// Products: one source, bounded, canonical
// ---------------------------------------------------------------------------

test("featured products are bounded and ordered the way the catalog calls Featured", () => {
  assert.match(catalogData, /export async function loadFeaturedProducts\(limit = 6\)/);
  assert.match(catalogData, /\.limit\(limit\)/);
  assert.match(catalogData, /\.order\("sort_order"\)[\s\S]{0,80}\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(page, /loadFeaturedProducts\(6\)/);
});

test("the homepage reads product media in one query, not one per card", () => {
  const fn = catalogData.slice(catalogData.indexOf("export async function loadFeaturedProducts"));
  assert.equal((fn.match(/from\("product_media"\)/g) ?? []).length, 1);
  assert.match(fn, /\.in\(\s*"product_id"/);
});

test("the homepage does not build a second catalog", () => {
  for (const banned of ["CatalogBrowser", "CatalogPageView", "CatalogCategoryTree", "CatalogBrowseDrawer", "CatalogViewControl"]) {
    assert.doesNotMatch(page, new RegExp(banned), `the homepage must not render ${banned}`);
    assert.doesNotMatch(sectionsSource, new RegExp(banned), `the homepage must not render ${banned}`);
  }
  // No second category-discovery surface: that navigator belongs to /catalog,
  // and pass 22 removed the duplicate one it already had.
  assert.doesNotMatch(markup, /catalog-browse|catalog-category-tree|catalog-filter-chip/);
});

test("product cards on the homepage are the shared card", () => {
  assert.match(sectionsSource, /import ProductCard/);
  assert.match(markup, /class="product-card"/);
  // and they link canonically
  assert.match(markup, /href="\/catalog\/billet-shift-knob"/);
});

test("the enlarged product takes every word from the product row", () => {
  assert.match(markup, /home-focus/);
  assert.match(markup, /Billet Shift Knob/);
  assert.match(markup, /Turned from 6061 aluminum\./);
  // Price comes from the catalog's own formatter, so a quote-only product
  // cannot be shown a price it does not have.
  assert.match(sectionsSource, /priceLabel\(mode, product\.starting_price_cents\)/);
  const focusOnly = renderHome({ products: [quoteOnly] });
  assert.match(focusOnly, /Price after review/);
  assert.doesNotMatch(focusOnly.slice(focusOnly.indexOf("home-focus")), /\$0\.00/);
});

test("no products means a complete page, not a page with holes", () => {
  assert.doesNotMatch(bare, /home-focus-copy/, "the focus section removes itself");
  assert.doesNotMatch(bare, /home-work-grid/, "the recent-work section removes itself");
  assert.match(bare, /home-empty/, "the product row explains itself");
  assert.match(bare, /home-media-sheet/, "frames fall back to the drawn panel");
  assert.match(bare, /<h1/);
  assert.match(bare, /home-close-title/);
});

// ---------------------------------------------------------------------------
// Project data: public only
// ---------------------------------------------------------------------------

test("recent work reads as the public, so RLS is behind the filter", () => {
  assert.match(recentWorkSource, /supabasePublicServer/);
  assert.doesNotMatch(recentWorkSource, /supabaseAdmin/);
  assert.doesNotMatch(page, /supabaseAdmin/, "the homepage must not use the service role");
});

test("recent work is bounded and restricted to the statuses the read policy calls public", () => {
  assert.match(recentWorkSource, /PUBLIC_WORK_STATUSES = \["approved", "published"\]/);
  assert.match(recentWorkSource, /\.in\("status", PUBLIC_WORK_STATUSES/);
  assert.match(recentWorkSource, /\.limit\(limit\)/);
  assert.match(page, /loadRecentWork\(3\)/);
});

test("no author, no counts, no forum metadata reaches the homepage", () => {
  // Comments stripped: the module's own docstring quotes the RLS policy, which
  // names `created_by` precisely because the query must not select it.
  const code = recentWorkSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /created_by|author|content_markdown/);
  for (const banned of [/karma/i, /upvote/i, /\breplies\b/i, /comment count/i, /posted by/i]) {
    assert.doesNotMatch(markup, banned, `homepage must not show ${banned}`);
  }
  assert.match(markup, /href="\/projects\/seized-indexer"/, "work links canonically");
});

// ---------------------------------------------------------------------------
// Copy: nothing invented
// ---------------------------------------------------------------------------

test("the copy claims no statistic the business has no source for", () => {
  const words = Object.values(content)
    .map((value) => JSON.stringify(value))
    .join(" ");

  const inventions: [RegExp, string][] = [
    [/\b\d+\+?\s*(years|yrs)\b/i, "years in business"],
    [/\b\d[\d,]*\s*(customers|clients|orders|parts)\s+(served|shipped|made|delivered)/i, "a volume claim"],
    [/\b\d+(\.\d+)?\s*(star|\/5)\b/i, "a review score"],
    [/±\s*0?\.\d+|\b\d+\s*(thou|micron|µm)\b/i, "a tolerance figure"],
    [/\bISO\s*\d|\bAS9100\b|\bcertified\b/i, "a certification"],
    [/\bsame[- ]day\b|\b\d+\s*[- ]?(hour|day)\s+turnaround\b/i, "a turnaround promise"],
    [/\btrusted by\b|\bindustry[- ]leading\b|\bcutting[- ]edge\b|\bworld[- ]class\b/i, "marketing filler"],
  ];

  for (const [pattern, label] of inventions) {
    assert.doesNotMatch(words, pattern, `homepage copy must not claim ${label}`);
  }
});

test("the trust signals are behaviours of this application", () => {
  const titles = content.assurances.map((item) => item.title).join(" | ");
  assert.match(titles, /approve/i);
  assert.match(titles, /person/i);
  assert.match(titles, /Stripe/i);
  assert.equal(content.assurances.length, 4);
  // Each one has to say something, not just be a label.
  for (const item of content.assurances) assert.ok(item.body.length > 30, `${item.title} needs a real explanation`);
});

test("the materials list keeps the limit it states elsewhere", () => {
  const capabilities = read("src/app/capabilities/page.tsx");
  for (const material of content.materials) {
    const head = material.title.replace(/\?$/, "");
    if (head === "Something else") continue;
    assert.match(capabilities, new RegExp(head, "i"), `${head} is claimed on the homepage but not on /capabilities`);
  }
  assert.match(content.materials.map((m) => m.title).join(" "), /Something else/, "the homepage must name its limit");
});

test("all homepage copy lives in the content module", () => {
  // A sentence written straight into a section is a sentence the honesty
  // assertions above cannot see.
  const prose = [...sectionsSource.matchAll(/>\s*([A-Z][a-z]+(?: [a-z,'—-]+){6,})\s*</g)].map((m) => m[1]);
  assert.deepEqual(prose, [], `prose found in JSX: ${prose.join(" / ")}`);
});

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

test("the homepage introduces no colour of its own", () => {
  const declarations = homeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const hexes = declarations.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  // Shadows are neutral black at an alpha, which no appearance role controls.
  const nonShadow = hexes.filter((hex) => !/^#0{3,8}$/i.test(hex));
  assert.deepEqual(nonShadow, [], `homepage CSS hard-codes colours: ${nonShadow.join(", ")}`);
  assert.doesNotMatch(declarations, /\b(rgb|hsl)a?\((?!0 0 0)/, "homepage CSS must go through the theme variables");
});

test("every call to action is a semantic role, not a hero-only button", () => {
  const buttons = [...markup.matchAll(/class="([^"]*\bui-btn\b[^"]*)"/g)].map((m) => m[1]!);
  assert.ok(buttons.length >= 6);
  for (const cls of buttons) {
    assert.match(cls, /ui-btn-(primary|secondary|ghost)/, `a call to action carries no role: ${cls}`);
  }
  // The size utility may set spacing; it must not set colour.
  const sizeRule = homeCss.slice(homeCss.indexOf(".home-cta-lg"), homeCss.indexOf(".home-cta-lg") + 240);
  assert.doesNotMatch(sizeRule, /background|color:|border-color/);
});

test("homepage surfaces use the shared panel roles", () => {
  for (const role of ["--panel", "--panel-strong", "--border", "--brand-primary", "--muted", "--heading"]) {
    assert.ok(homeCss.includes(`var(${role})`), `homepage CSS should consume ${role}`);
  }
  // Card style and content width remain the Appearance editor's to control.
  assert.match(homeCss, /\[data-card-style="solid"\]/);
  assert.match(homeCss, /\[data-content-width="wide"\] \.home-shell/);
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

test("nothing on the homepage is hidden unless motion was explicitly enabled", () => {
  assert.match(globalsCss, /\[data-motion="on"\]\s+\.reveal\s*\{/);
  // Every rule that hides or moves something must be gated.
  for (const keyframe of ["home-media-drift", "home-rail-fill", "home-cue-slide"]) {
    const uses = [...homeCss.matchAll(new RegExp(`animation:\\s*${keyframe}`, "g"))];
    assert.ok(uses.length > 0, `${keyframe} is defined but never used`);
    for (const use of uses) {
      const before = homeCss.slice(0, use.index);
      const guard = before.lastIndexOf("prefers-reduced-motion: no-preference");
      const gate = before.lastIndexOf('[data-motion="on"]');
      assert.ok(guard > -1 && gate > guard, `${keyframe} must sit behind reduced motion and the motion flag`);
    }
  }
});

test("scroll-linked movement is CSS, with no listener and no dependency", () => {
  assert.match(homeCss, /animation-timeline: view\(\)/);
  assert.match(homeCss, /@supports \(animation-timeline: view\(\)\)/);
  for (const source of [heroSource, sectionsSource, mediaSource]) {
    assert.doesNotMatch(source, /addEventListener\(\s*["']scroll/, "no scroll listeners on the homepage");
    assert.doesNotMatch(source, /requestAnimationFrame/, "no rAF loops on the homepage");
    assert.doesNotMatch(source, /"use client"/, "homepage sections stay renderable on the server");
  }
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  for (const banned of ["framer-motion", "gsap", "motion", "react-spring", "aos", "lottie-react", "locomotive-scroll", "lenis"]) {
    assert.ok(!(banned in pkg.dependencies), `unexpected animation dependency: ${banned}`);
  }
});

test("the rail's fill carries no meaning, so removing it removes nothing", () => {
  assert.match(sectionsSource, /className="home-process-rail" aria-hidden="true"/);
  // Authored full: a browser with no scroll-driven animation shows a complete
  // rail rather than an empty one.
  const rule = homeCss.slice(homeCss.indexOf(".home-process-rail-fill {"));
  assert.doesNotMatch(rule.slice(0, rule.indexOf("}")), /transform:\s*scale/);
});

test("the pre-paint motion flag still respects reduced motion", () => {
  assert.match(layout, /prefers-reduced-motion: reduce/);
  assert.match(layout, /document\.documentElement\.dataset\.motion='on'/);
});

// ---------------------------------------------------------------------------
// Responsive and performance
// ---------------------------------------------------------------------------

test("the split sections all turn at the same width", () => {
  const desktop = homeCss.slice(homeCss.indexOf("@media (min-width: 1024px)"));
  for (const cls of [".home-hero-inner", ".home-focus", ".home-process", ".home-assurance-layout"]) {
    assert.ok(desktop.includes(cls), `${cls} must become two columns at the shared desktop breakpoint`);
  }
  // and the sticky story exists only there
  assert.match(desktop, /\.home-process-intro \{ position: sticky/);
  assert.equal((homeCss.match(/position: sticky/g) ?? []).length, 1, "one sticky section, not several");
});

test("the hero frame is reshaped for each layout it lands in", () => {
  assert.match(homeCss, /\.home-hero-frame-lead \{\s*aspect-ratio: 4 \/ 5/);
  assert.match(homeCss, /@media \(min-width: 480px\)[\s\S]{0,400}aspect-ratio: 3 \/ 2/);
  assert.match(homeCss, /@media \(min-width: 1024px\)[\s\S]{0,900}aspect-ratio: 4 \/ 5/);
  // The component must not fight CSS for it.
  assert.doesNotMatch(heroSource, /ratio="[^"]*"\s*\n?\s*sizes[\s\S]{0,80}home-hero-frame-lead/);
});

test("every media frame reserves its space before anything loads", () => {
  assert.match(homeCss, /\.home-media \{[\s\S]*?aspect-ratio: var\(--home-media-ratio, 4 \/ 3\)/);
  assert.match(markup, /class="home-media[^"]*"[^>]*style="--home-media-ratio/);
});

test("exactly one image is eager, and it is the hero", () => {
  const priorities = [...markup.matchAll(/fetchPriority="high"|loading="eager"/g)];
  assert.ok(priorities.length <= 2, "only the hero image may be eager");
  const heroEnd = markup.indexOf("home-hero-foot");
  for (const match of priorities) assert.ok(match.index! < heroEnd, "an eager image was found below the hero");
  assert.doesNotMatch(sectionsSource, /priority=\{index === 0\}/, "the featured row is far below the fold");
  assert.match(heroSource, /\spriority\s/, "the hero image is the LCP candidate");
});

test("the page states a responsive width for every frame it renders", () => {
  const frames = [...markup.matchAll(/class="home-media[^"]*"/g)].length;
  assert.ok(frames >= 3);
  for (const source of [heroSource, sectionsSource]) {
    for (const call of source.match(/<HomeMedia[\s\S]*?\/>/g) ?? []) {
      assert.match(call, /sizes=/, `a HomeMedia call gives the optimizer no width hint:\n${call}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

test("the homepage declares its own canonical, title and description", () => {
  assert.match(page, /alternates: \{ canonical: "\/" \}/);
  assert.match(page, /openGraph: \{ title, description: meta\.description, url: "\/" \}/);
  assert.ok(content.meta.description.length > 80 && content.meta.description.length < 220);
  // Keyword stuffing check: no term repeated to excess in the description.
  const terms = content.meta.description.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [term, n] of counts) assert.ok(n <= 3, `"${term}" appears ${n} times in the description`);
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

test("the pass introduces no migration", () => {
  const migrations = readdirSync("supabase/migrations");
  for (const name of migrations) {
    assert.ok(name <= "20260811030000_security_boundary_hardening.sql", `unexpected migration: ${name}`);
  }
  assert.ok(migrations.includes("20260811025000_public_profile_projection.sql"));
  assert.ok(migrations.includes("20260811030000_security_boundary_hardening.sql"));
  for (const source of [page, sectionsSource, heroSource, recentWorkSource, contentSource]) {
    assert.doesNotMatch(source, /create table|alter table|create policy|grant /i);
  }
});

test("the catalog list view cannot reach the homepage product row", () => {
  // The attribute lives on <html> and survives a client navigation off the
  // catalog, so the list-view rules stay scoped to .catalog-grid.
  for (const match of globalsCss.match(/\[data-catalog-density="list"\][^{]*\{/g) ?? []) {
    assert.match(match, /\.catalog-grid/, `unscoped list-view rule would reshape the homepage: ${match}`);
  }
});

test("the harness renders the same sections the route does", () => {
  const sections = [
    "HomeHero",
    "HomeCapabilities",
    "HomeProductFocus",
    "HomeFeaturedProducts",
    "HomeCustomProject",
    "HomeProcess",
    "HomeMaking",
    "HomeRecentWork",
    "HomeAssurances",
    "HomeFinalCta",
  ];
  for (const section of sections) {
    assert.match(page, new RegExp(`<${section}\\b`), `the route must render ${section}`);
    assert.match(harness, new RegExp(`<${section}\\b`), `the harness must render ${section}`);
  }
  // and it renders the empty composition too, which is the one nobody looks at
  assert.match(harness, /data-surface="home-bare"/);
});
