import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cardAction, priceLabel, productPrice } from "../src/components/ProductCard.tsx";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Comments are stripped up front: these rules are heavily commented, and a
// declaration sitting after a comment block would otherwise look absent.
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
const card = read("src/components/ProductCard.tsx");

/**
 * The declarations of one rule, by exact selector.
 *
 * Deliberately exact rather than a substring search: `.product-card-action` and
 * `.product-card:hover .product-card-action` are different rules with different
 * jobs, and conflating them is how a test passes while the bug is live.
 */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `globals.css must define a rule for \`${selector}\``);
  return match[1];
}

function declaration(selector: string, property: string): string | null {
  const body = ruleBody(selector);
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "im"));
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

/**
 * The bug: `.product-card:hover .product-card-action` set `filter`, which makes
 * the span establish a stacking context. A stacking context with `z-index:
 * auto` paints alongside positioned boxes in *tree order*, and the span follows
 * the anchor in the DOM — so on hover it covered the anchor's `inset: 0`
 * overlay and swallowed the click. Off hover there was no filter, no stacking
 * context, and the overlay won. Hence "the whole card works except the button",
 * and only for a pointer, because hovering is what broke it.
 */
test("the call-to-action cannot capture a click meant for the card", () => {
  assert.equal(
    declaration(".product-card-action", "pointer-events"),
    "none",
    "the call-to-action is decorative and must let clicks reach the card's overlay"
  );
});

test("the card overlay is layered above decorative content explicitly", () => {
  const overlay = ruleBody(".product-card-link::after");
  assert.match(overlay, /position:\s*absolute/);
  assert.match(overlay, /inset:\s*0/);

  const overlayZ = Number(declaration(".product-card-link::after", "z-index"));
  assert.ok(
    Number.isFinite(overlayZ),
    "the overlay needs an explicit z-index; relying on paint order is what broke it"
  );
  assert.ok(overlayZ >= 1, "the overlay must sit above the card's in-flow content");
});

test("independent controls are lifted above the overlay, not left under it", () => {
  const asideRaw = declaration(".product-card-aside", "z-index");
  const overlayRaw = declaration(".product-card-link::after", "z-index");
  assert.ok(asideRaw, ".product-card-aside must set a z-index");
  assert.ok(overlayRaw, "the overlay must set a z-index for this comparison to mean anything");

  const asideZ = Number(asideRaw);
  const overlayZ = Number(overlayRaw);
  assert.ok(Number.isFinite(asideZ), ".product-card-aside must set a numeric z-index");
  assert.ok(
    asideZ > overlayZ,
    `the wishlist control must clear the overlay (aside ${asideZ} vs overlay ${overlayZ})`
  );
  assert.match(ruleBody(".product-card-aside"), /position:\s*absolute/);
});

/**
 * The guard that generalizes the fix. Any descendant of the card that gains a
 * stacking-context property is a candidate for reopening this bug; each one has
 * to be accounted for rather than merely absent today.
 */
test("every stacking-context property inside the card is accounted for", () => {
  const STACKING = /(?:^|;)\s*(filter|opacity|transform|will-change|mix-blend-mode|backdrop-filter|isolation)\s*:/i;

  // Selector → why it cannot punch a hole in the hit target.
  const ACCOUNTED: Record<string, string> = {
    ".product-card:hover": "the card itself is the overlay's containing block, not a sibling of it",
    ".product-card:hover .product-card-action": "the span is pointer-events: none and below the overlay",
    ".product-card:hover .product-image-media": "the image box precedes the anchor in tree order",
  };

  const rules = css.matchAll(/(?:^|[};])\s*([^{};]*\.product-card[^{}]*?)\s*\{([^}]*)\}/g);
  const offenders: string[] = [];

  for (const [, selector, body] of rules) {
    if (!STACKING.test(body)) continue;
    const key = selector.trim();
    if (!(key in ACCOUNTED)) offenders.push(key);
  }

  assert.deepEqual(
    offenders,
    [],
    `these rules create a stacking context inside the product card and must be ` +
      `proven not to cover the click overlay (add to the allow-list with a reason): ${offenders.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Markup contract: one destination, one tab stop, one activation
// ---------------------------------------------------------------------------

test("the card exposes exactly one anchor", () => {
  const anchors = card.match(/<Link\b/g) ?? [];
  assert.equal(
    anchors.length,
    1,
    "a second link to the same product would give it two tab stops, two screen-reader " +
      "announcements, and two analytics activations for one click"
  );
});

test("the call-to-action is decorative markup, not an interactive element", () => {
  assert.match(card, /<span className="product-card-action" aria-hidden="true">/);
  // A button inside the stretched anchor's overlay, or a role that promises
  // keyboard activation the span does not implement, both regress this.
  assert.doesNotMatch(card, /<button[^>]*product-card-action/);
  assert.doesNotMatch(card, /product-card-action[^>]*role=/);
  assert.doesNotMatch(card, /product-card-action[^>]*tabIndex/);
});

test("the card carries no click handler competing with the link", () => {
  // Navigation lives in the anchor. A card-level onClick is the other classic
  // way this breaks: it double-fires with the link, or fires when the wishlist
  // button is pressed.
  assert.doesNotMatch(card, /<article[^>]*onClick/);
  assert.doesNotMatch(card, /useRouter|router\.push/);
});

test("the wishlist control is a real button that stops at itself", () => {
  const aside = card.match(/className="product-card-aside"[\s\S]{0,220}/)?.[0] ?? "";
  assert.ok(aside, "the card must render the .product-card-aside wrapper");
  assert.match(aside, /<WishlistButton/, "the aside exists to host the wishlist toggle");
});

test("the keyboard target is the anchor, and it shows a ring around the card", () => {
  // Links activate on Enter, not Space — so no role=button is claimed anywhere,
  // and the focus ring is drawn on the overlay so the visible target matches
  // the clickable one.
  assert.match(css, /\.product-card-link:focus-visible::after\s*\{[^}]*outline:/);
  assert.match(card, /<Link href=\{href\} className="product-card-link">/);
});

test("the product image sits inside the card's hit target", () => {
  // ProductImage renders before the anchor, so the overlay covers it. If it
  // ever moved after the anchor and gained a transform it would escape.
  const imageAt = card.indexOf("<ProductImage");
  const linkAt = card.indexOf("<Link href={href}");
  assert.ok(imageAt > -1 && linkAt > -1);
  assert.ok(imageAt < linkAt, "the image must precede the anchor so the overlay paints over it");
});

// ---------------------------------------------------------------------------
// Purchase-mode wording, including the unavailable state
// ---------------------------------------------------------------------------

test("each purchase mode keeps its own call-to-action wording", () => {
  assert.equal(cardAction("direct_purchase", true), "Buy now");
  assert.equal(cardAction("direct_or_request", true), "Buy or customize");
  assert.equal(cardAction("request_only", true), "Customize");
});

test("an unavailable product offers View in every mode", () => {
  for (const mode of ["direct_purchase", "direct_or_request", "request_only"] as const) {
    assert.equal(cardAction(mode, false), "View", `${mode} must fall back to View when unavailable`);
  }
});

test("a directly purchasable price is exact, a request price is a starting point", () => {
  assert.equal(priceLabel("direct_purchase", 4000), "$40.00");
  assert.equal(priceLabel("request_only", 4000), "From $40.00");
  assert.equal(priceLabel("direct_or_request", 4000), "From $40.00");
  assert.equal(priceLabel("direct_purchase", null), "Price after review");
  assert.equal(productPrice(null), "Price after review");
  assert.equal(productPrice(4000), "From $40.00");
});

// ---------------------------------------------------------------------------
// One card component across every surface
// ---------------------------------------------------------------------------

test("every product grid renders the shared card rather than its own markup", () => {
  for (const path of ["src/app/page.tsx", "src/app/catalog/page.tsx"]) {
    const source = read(path);
    assert.match(source, /<ProductCard\b/, `${path} must render the shared card`);
    assert.doesNotMatch(
      source,
      /className="product-card-action"/,
      `${path} must not hand-roll a card action; the fix lives in one component`
    );
  }
});
