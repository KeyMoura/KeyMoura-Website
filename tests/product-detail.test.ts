import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProductSections,
  EMPTY_DETAIL_CONTENT,
  formatWeight,
  hasStructuredContent,
  INSTALLATION_DIFFICULTY_LABEL,
  parseDetailContent,
  parseProductFacts,
  quickFacts,
  serializeDetailContent,
} from "../src/lib/commerce/productContent.ts";
import { shouldHideStickyBar } from "../src/components/product/ProductStickyBar.tsx";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const page = read("src/app/catalog/[slug]/page.tsx");
const gallery = read("src/components/product/ProductGallery.tsx");
const panel = read("src/components/product/ProductPurchasePanel.tsx");
const sections = read("src/components/product/ProductSections.tsx");
const migration = read("supabase/migrations/20260804030000_product_detail_content.sql");
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * Source with comments removed.
 *
 * Several assertions below are of the form "this string must not appear". The
 * prose in these files explains *why* each thing is avoided and therefore names
 * it — the comment above `ProductSections` says the word
 * `dangerouslySetInnerHTML` in order to say it is not used. Matching the
 * comment instead of the code makes the test fail on the documentation.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ---------------------------------------------------------------------------
// Parsing — total, and defensive about what is actually in the column
// ---------------------------------------------------------------------------

test("any input at all yields a renderable structure", () => {
  // A product page must not fail to render because a row holds something odd.
  for (const input of [null, undefined, "", "nope", 42, [], [{ title: "x" }], true]) {
    const parsed = parseDetailContent(input);
    assert.deepEqual(parsed, EMPTY_DETAIL_CONTENT, `${JSON.stringify(input)} must parse to empty`);
  }
});

test("blank rows left behind in the editor are dropped", () => {
  const parsed = parseDetailContent({
    benefits: [{ title: "  ", body: "   " }, { title: "Real", body: "" }],
    specifications: [
      { name: "Material", value: "" },
      { name: "", value: "6061" },
      { name: "Finish", value: "Anodised" },
    ],
    compatibility: [{ value: "" }, { value: "M10x1.25" }],
    included: [{ value: "  " }],
    faq: [{ question: "", answer: "" }],
  });

  assert.equal(parsed.benefits.length, 1, "a title-only benefit is content; a whitespace one is not");
  assert.equal(parsed.benefits[0].title, "Real");
  // A spec needs both halves: a value with no name is unlabelled, a name with
  // no value answers nothing.
  assert.deepEqual(parsed.specifications, [{ name: "Finish", value: "Anodised" }]);
  assert.deepEqual(parsed.compatibility, [{ value: "M10x1.25", note: "" }]);
  assert.equal(parsed.included.length, 0);
  assert.equal(parsed.faq.length, 0);
});

test("a row that already holds too much is bounded on read", () => {
  // Truncating at parse time means the page is bounded no matter how the data
  // got there — including rows written before any editor limit existed.
  const huge = parseDetailContent({
    specifications: Array.from({ length: 500 }, (_, i) => ({ name: `n${i}`, value: `v${i}` })),
    benefits: [{ title: "t", body: "x".repeat(50_000) }],
  });
  assert.equal(huge.specifications.length, 60);
  assert.ok(huge.benefits[0].body.length <= 2000);
});

test("serializing round-trips through the same parser", () => {
  // An editor cannot save a shape the page would then discard.
  const content = parseDetailContent({
    benefits: [{ title: "A", body: "B" }],
    faq: [{ question: "Q", answer: "A" }],
  });
  const round = serializeDetailContent(content);
  assert.deepEqual(round, content);
  assert.equal(round.faq[0].title, "Q", "faq keeps question/answer through the trip");
});

test("hasStructuredContent is false only when every section is empty", () => {
  assert.equal(hasStructuredContent(EMPTY_DETAIL_CONTENT), false);
  assert.equal(hasStructuredContent(parseDetailContent({ included: [{ value: "Knob" }] })), true);
});

// ---------------------------------------------------------------------------
// Facts and the quick-information row
// ---------------------------------------------------------------------------

test("facts parse defensively and reject impossible values", () => {
  const facts = parseProductFacts({
    material: "  6061 aluminium  ",
    installation_difficulty: "wizardry",
    weight_grams: -20,
    made_to_order: "yes",
  });
  assert.equal(facts.material, "6061 aluminium", "trimmed");
  assert.equal(facts.installationDifficulty, null, "an unknown difficulty is not rendered as a label");
  assert.equal(facts.weightGrams, null, "a negative weight would render as '-20 g'");
  assert.equal(facts.madeToOrder, false, "only a real boolean counts");
});

test("weight reads the way a person would say it", () => {
  assert.equal(formatWeight(null), null);
  assert.equal(formatWeight(400), "400 g");
  assert.equal(formatWeight(999), "999 g");
  assert.equal(formatWeight(1000), "1 kg", "not '1.0 kg'");
  assert.equal(formatWeight(1400), "1.4 kg");
});

test("the quick-info row renders only facts that are set", () => {
  // No empty placeholders: a sparse product gets a short row, and a product
  // with nothing set gets none at all so the block disappears.
  assert.deepEqual(quickFacts(parseProductFacts({}), { readyToShip: false }), []);

  const row = quickFacts(parseProductFacts({ material: "Delrin", sku: "KM-1" }), { readyToShip: false });
  assert.deepEqual(row, [
    { label: "Material", value: "Delrin" },
    { label: "SKU", value: "KM-1" },
  ]);
});

test("ready-to-ship and made-to-order are never both claimed", () => {
  const madeToOrder = quickFacts(parseProductFacts({ made_to_order: true }), { readyToShip: true });
  const labels = madeToOrder.map((f) => f.value);
  assert.ok(labels.includes("Made to order"));
  assert.ok(!labels.includes("Ready to ship"), "a made-to-order part is not on a shelf");

  const stocked = quickFacts(parseProductFacts({}), { readyToShip: true });
  assert.deepEqual(stocked, [{ label: "Availability", value: "Ready to ship" }]);
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test("an empty product renders no sections at all", () => {
  const sectionsOut = buildProductSections({
    description: null,
    content: EMPTY_DETAIL_CONTENT,
    facts: parseProductFacts({}),
  });
  assert.deepEqual(sectionsOut, [], "a heading over nothing reads as a broken page");
});

test("a sparse product renders exactly the sections it has", () => {
  const built = buildProductSections({
    description: "A knob.",
    content: EMPTY_DETAIL_CONTENT,
    facts: parseProductFacts({ lead_time_text: "1–2 weeks" }),
  });
  assert.deepEqual(
    built.map((s) => s.id),
    ["overview", "shipping"]
  );
});

test("a fully populated product renders every section, in order", () => {
  const built = buildProductSections({
    description: "Long description.",
    content: parseDetailContent({
      benefits: [{ title: "Strong", body: "Machined from billet." }],
      specifications: [{ name: "Thread", value: "M10x1.25" }],
      compatibility: [{ value: "Miata NA/NB" }],
      included: [{ value: "Knob" }, { value: "Adapter" }],
      faq: [{ question: "Fitment?", answer: "Most Japanese threads." }],
    }),
    facts: parseProductFacts({
      material: "6061",
      finish: "Anodised",
      dimensions_text: "50 × 50 mm",
      weight_grams: 320,
      installation_difficulty: "easy",
      installation_notes: "Thread on by hand.",
      care_instructions: "Wipe with a dry cloth.",
      warranty_text: "Workmanship, 12 months.",
      shipping_notes: "Ships in 2 days.",
      lead_time_text: "3 days",
      return_notes: "30 days.",
      cancellation_notes: "Before production starts.",
    }),
  });

  assert.deepEqual(
    built.map((s) => s.id),
    [
      "overview",
      "benefits",
      "specifications",
      "materials",
      "compatibility",
      "included",
      "installation",
      "care",
      "shipping",
      "warranty",
      "returns",
      "faq",
    ]
  );

  // Material and finish become their own section rather than being duplicated
  // into the spec table.
  const materials = built.find((s) => s.id === "materials");
  assert.deepEqual(materials?.specs?.map((s) => s.name), ["Material", "Finish", "Dimensions", "Weight"]);

  // The difficulty is rendered as its label, never the raw enum.
  const install = built.find((s) => s.id === "installation");
  assert.match(install?.body ?? "", new RegExp(INSTALLATION_DIFFICULTY_LABEL.easy));
  assert.doesNotMatch(install?.body ?? "", /^easy$/);
});

test("sections use native details so they work before hydration", () => {
  assert.match(sections, /<details/);
  assert.match(sections, /<summary/);
  // A hand-built accordion here would be a client component, a useState, four
  // ARIA attributes and a keyboard handler to reach what the browser does.
  assert.doesNotMatch(sections, /"use client"/);
  assert.doesNotMatch(sections, /aria-expanded/);
  // Deep links open their section without JavaScript deciding anything.
  assert.match(css, /\.product-section:target/);
  assert.match(sections, /id=\{section\.id\}/);
});

test("staff-entered content is never rendered as HTML", () => {
  for (const [name, source] of [
    ["sections", sections],
    ["page", page],
    ["panel", panel],
  ] as const) {
    assert.doesNotMatch(code(source), /dangerouslySetInnerHTML/, `${name} must not render raw HTML`);
  }
  // Newlines survive through CSS rather than by splitting into elements.
  assert.match(css, /\.product-section-prose \{[^}]*white-space: pre-line/);
});

// ---------------------------------------------------------------------------
// Purchase modes
// ---------------------------------------------------------------------------

test("request-only never offers a cart", () => {
  // `canBuy` requires the mode to allow it; there is no branch that renders Add
  // to cart without it.
  assert.match(panel, /const canBuy =\s*\n?\s*modeAllowsBuy && startingPriceCents != null && available && inStock && !requestOnlyChoice/);
  assert.match(panel, /\{canBuy \? \(/);
});

test("a request-only configuration cannot enter direct checkout", () => {
  // An option value flagged `requires_request` is the shop saying "I can make
  // that, but not at the listed price". Selecting one swaps the action.
  assert.match(panel, /requestOnlyChoice = selectedValues\.find\(\(entry\) => entry\.value\?\.requires_request\)/);
  assert.match(panel, /!requestOnlyChoice/);
  // And it explains itself rather than leaving a disabled button.
  assert.match(panel, /is quoted rather than sold at the listed/);
});

test("the wizard owns configuration when there is no cart path", () => {
  // Otherwise a request-only product asks for a material twice, in two
  // controls that do not talk to each other.
  assert.match(panel, /allowsDirectPurchase\(purchaseMode\)\s*\n?\s*\? groups\.filter/);
});

test("a priced request-only product agrees with its catalog card", () => {
  // The card says "From $20.00"; a page saying "Priced after review" for the
  // same product reads as a pricing error.
  assert.match(panel, /From \$\$\{\(startingPriceCents \/ 100\)\.toFixed\(2\)\}/);
  assert.match(panel, /startingPriceCents == null\s*\n?\s*\? "Priced after review"/);
});

test("only choice inputs can drive a cart line", () => {
  // A cart line stores option values from a fixed set; free text, numbers,
  // checkboxes and uploads are request-wizard concerns.
  assert.match(panel, /\["select", "radio"\]\.includes\(group\.input_type\)/);
});

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

test("the gallery reserves its box before anything loads", () => {
  const rule = css.match(/\.product-gallery-frame \{([^}]*)\}/);
  assert.ok(rule, "globals.css must define .product-gallery-frame");
  assert.match(rule[1], /aspect-ratio: 4 \/ 3/, "a slow image must not push the purchase panel down");
});

test("thumbnails are vertical on desktop and the rule can win", () => {
  // Both selectors have the same specificity, so the responsive override has to
  // come after the base rule in source order. Written above it, the base
  // `grid-auto-flow: column` won at every width and the strip stayed
  // horizontal on desktop no matter what the media query said.
  const base = css.indexOf(".product-gallery-thumbs {");
  const override = css.indexOf("grid-template-areas: \"thumbs main\"");
  assert.ok(base > 0 && override > 0, "both rules must exist");
  assert.ok(override > base, "the lg override must come after the base rule");
});

test("the gallery does not re-implement image resolution", () => {
  // A second resolver is how the gallery and the cards start disagreeing about
  // which photograph is the cover.
  assert.doesNotMatch(gallery, /product_media/, "the caller passes resolved images");
  assert.match(page, /normalizeImageUrl/);
  assert.match(page, /primaryProductImage/);
});

test("fullscreen is a real dialog", () => {
  assert.match(gallery, /role="dialog"/);
  assert.match(gallery, /aria-modal="true"/);
  assert.match(gallery, /body\.style\.overflow = "hidden"/);
  assert.match(gallery, /closeRef\.current\?\.focus\(\)/, "focus moves in");
  assert.match(gallery, /expandRef\.current\?\.focus\(\)/, "and back out to the control that opened it");
  assert.match(gallery, /event\.key === "ArrowRight"/);
});

test("thumbnails are keyboard navigable and show which is selected", () => {
  assert.match(gallery, /onThumbKeyDown/);
  assert.match(gallery, /ArrowRight" \|\| event\.key === "ArrowDown"/);
  assert.match(gallery, /aria-current=\{!showModelView && position === index \? "true" : undefined\}/);
  assert.match(css, /\.product-gallery-thumb\.is-selected/);
});

test("zoom is disabled where it would fight the interface", () => {
  assert.match(gallery, /prefers-reduced-motion: reduce/);
  assert.match(gallery, /\(hover: hover\) and \(pointer: fine\)/, "no hover state exists on touch");
});

// ---------------------------------------------------------------------------
// Mobile and layout
// ---------------------------------------------------------------------------

test("the sticky bar hides whenever a real action is on screen", () => {
  assert.equal(shouldHideStickyBar(0), false);
  assert.equal(shouldHideStickyBar(1), true);
  assert.equal(shouldHideStickyBar(2), true);
});

test("the sticky bar mirrors the action the product actually offers", () => {
  // It must never advertise a cart on a request-only product.
  assert.match(panel, /\{canBuy \? \(\s*\n?\s*<ProductStickyBar label="Add to cart"/);
  assert.match(panel, /canRequest \? \(\s*\n?\s*<ProductStickyBar label="Request a quote"/);
});

test("the sticky bar clears the safe area and does not trap the footer", () => {
  const rule = css.match(/\.product-sticky-bar \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /env\(safe-area-inset-bottom\)/);
  // The page needs clearance under a fixed control or its last row is
  // unreachable behind it.
  assert.match(css, /@media \(max-width: 1023px\) \{\s*\.product-page \{ padding-bottom: 6\.5rem/);
  assert.match(css, /@media \(min-width: 1024px\) \{\s*\.product-sticky-bar \{ display: none/);
});

test("the sticky purchase panel cannot outgrow the viewport", () => {
  const rule = css.match(/\.product-info-sticky \{([^}]*)\}/);
  assert.ok(rule, "the sticky rule must exist");
  assert.match(rule[1], /position: sticky/);
  assert.match(rule[1], /max-height: calc\(100dvh/, "a tall panel must scroll rather than lose its foot");
  assert.match(rule[1], /var\(--km-header-height/, "one definition of the header height");
});

test("hit targets meet 44px", () => {
  for (const selector of ["product-option-choice", "product-quantity-input", "product-share", "product-sticky-action"]) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`));
    assert.ok(rule, `globals.css must define .${selector}`);
    assert.match(rule[1], /min-height: 2\.75rem/, `.${selector} must be at least 44px`);
  }
  // The radio inside a choice is visually hidden, so the ring is drawn on the
  // label or a keyboard user cannot see where they are.
  assert.match(css, /\.product-option-choice:has\(:focus-visible\)/);
});

// ---------------------------------------------------------------------------
// Rendering strategy
// ---------------------------------------------------------------------------

test("the product page is server-rendered", () => {
  // It used to be a client component that fetched in an effect: the first
  // paint was the word "Loading…", and a crawler or link preview got nothing.
  assert.doesNotMatch(page, /"use client"/);
  assert.match(page, /export async function generateMetadata/);
  assert.match(page, /export const revalidate/);
});

test("the page reads as the public, not as the service role", () => {
  // RLS is then a second guard behind every filter here, and the query is
  // exercisable locally — the service-role key in .env.local is deliberately
  // fake, which is why passes 3-5 could never verify a data path on this
  // machine.
  assert.match(page, /supabasePublicServer/);
  assert.doesNotMatch(code(page), /supabaseAdmin/);
  const client = code(read("src/lib/supabasePublicServer.ts"));
  assert.match(client, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.doesNotMatch(client, /SERVICE_ROLE/, "the client itself must never read the service key");
});

test("published and unarchived is asserted in the query, not assumed", () => {
  assert.match(page, /\.eq\("is_published", true\)/);
  assert.match(page, /\.is\("archived_at", null\)/);
});

test("the title is not doubled by the layout template", () => {
  // The root layout appends the site name; doing it here too produced
  // "Premade Shift Knob | KeyMoura | KeyMoura" in the tab.
  assert.match(page, /title: product\.name,/);
  assert.doesNotMatch(page, /title: `\$\{product\.name\} \| \$\{settings\.name\}`/);
});

test("no rating is fabricated", () => {
  // product_reviews exists but holds no rows and has no UI; a star row would
  // be decoration standing in for data that does not exist.
  //
  // Word-bounded: `starting_price_cents` contains "star", and matching it
  // would fail this test on the price field it is meant to protect.
  for (const [name, source] of [["page", page], ["panel", panel]] as const) {
    assert.doesNotMatch(code(source), /★|\bstars?\b|\bratings?\b|\breviewCount\b/i, `${name} must not fabricate a rating`);
  }
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("the migration is additive", () => {
  const sql = migration.replace(/--.*$/gm, "").toLowerCase();
  assert.doesNotMatch(sql, /drop\s+(table|column|constraint)/);
  assert.doesNotMatch(sql, /truncate/);
  assert.doesNotMatch(sql, /delete\s+from/);
  assert.doesNotMatch(sql, /alter\s+table\s+\S*products\s+alter/, "no existing column is altered");
  // Every column addition is idempotent and either nullable or defaulted, so
  // the live rows stay valid without being touched.
  const adds = sql.match(/add column if not exists/g) ?? [];
  assert.ok(adds.length >= 14, `expected the full set of columns, saw ${adds.length}`);
  assert.doesNotMatch(sql, /add column if not exists \w+ \w+ not null(?! default)/);
});

test("the migration does not touch grants", () => {
  // Column additions inherit the table's ACL. Issuing table grants here would
  // silently widen or narrow whatever is already in place — and the pass-5a
  // outage was caused by the opposite mistake on a *new* table.
  assert.doesNotMatch(migration.toLowerCase(), /^\s*grant /m);
  assert.doesNotMatch(migration.toLowerCase(), /^\s*revoke /m);
});

test("the database guarantees the shape the parser assumes", () => {
  const sql = migration.toLowerCase();
  assert.match(sql, /jsonb_typeof\(detail_content\) = 'object'/);
  assert.match(sql, /installation_difficulty in \('easy','moderate','advanced','professional'\)/);
  assert.match(sql, /weight_grams is null or weight_grams >= 0/);
  // The CHECK vocabulary and the TypeScript one cannot drift.
  for (const value of Object.keys(INSTALLATION_DIFFICULTY_LABEL)) {
    assert.ok(sql.includes(`'${value}'`), `${value} must be in the database CHECK`);
  }
});
