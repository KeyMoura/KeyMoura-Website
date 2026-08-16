import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const UTILITY_FIELDS = [
  "navigationUtilityBackground",
  "navigationUtilityBorder",
  "navigationUtilityText",
  "navigationUtilityHoverBackground",
  "navigationUtilityHoverBorder",
  "navigationUtilityHoverText",
] as const;

const UTILITY_CSS_VARS = [
  "--km-nav-util-bg",
  "--km-nav-util-border",
  "--km-nav-util-text",
  "--km-nav-util-hover-bg",
  "--km-nav-util-hover-border",
  "--km-nav-util-hover-text",
] as const;

test("Appearance exposes a dedicated navbar utility controls subsection", () => {
  const page = read("src/app/staff/appearance/page.tsx");
  const map = read("src/theme/appearanceMap.ts");

  // The utility colours are declared in the map now rather than hand-written
  // into the page's JSX. Each must still exist, and must additionally say what
  // it changes — the old assertion could not check that at all.
  for (const field of UTILITY_FIELDS) {
    assert.match(map, new RegExp(`key: "${field}"`), `${field} must be a declared, explained control`);
  }
  assert.match(map, /Utility button background/);
  assert.match(map, /Search, wishlist, cart, notifications and account buttons/);

  // "Reset this section" derives from the map instead of a hand-maintained key
  // list, so a colour added to one and not the other can no longer survive a
  // reset. Asserting the derivation is what makes the 19-key list unnecessary.
  //
  // Pass 4.0 split the colour list across Colours and Navigation, and the reset
  // reads the same `group` field the two sections are filtered by — so "what a
  // section shows" and "what it resets" still cannot drift.
  assert.match(page, /section === "colors" \|\| section === "navigation"[\s\S]{0,600}APPEARANCE_SETTINGS/);
  assert.match(page, /setting\.group === "navbar" \|\| setting\.group === "navbarMenus"/);

  // The live-preview CSS variable map must include the new tokens.
  for (const cssVar of UTILITY_CSS_VARS) {
    assert.match(page, new RegExp(cssVar.replace(/-/g, "\\-")));
  }

  // The navbar preview panel should render the utility cluster too.
  assert.match(page, /site-nav-utility/);
});

test("the root layout wires the navbar utility CSS variables from the saved theme", () => {
  const layout = read("src/app/layout.tsx");
  for (const cssVar of UTILITY_CSS_VARS) {
    assert.match(layout, new RegExp(cssVar.replace(/-/g, "\\-")));
  }
  for (const field of UTILITY_FIELDS) {
    assert.match(layout, new RegExp(`settings\\.theme\\.${field}`));
  }
});

test("navbar utility controls in globals.css read the dedicated tokens, not the shared navbar palette", () => {
  const css = read("src/app/globals.css");

  const utilityBlock = css.match(/\.site-header-shell \.site-nav-utility \{[\s\S]*?\.site-nav-utility-badge[\s\S]*?\}\r?\n/)?.[0];
  assert.ok(utilityBlock, "expected a .site-nav-utility rule block in globals.css");

  assert.match(utilityBlock!, /var\(--km-nav-util-bg/);
  assert.match(utilityBlock!, /var\(--km-nav-util-border/);
  assert.match(utilityBlock!, /var\(--km-nav-util-text/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-bg/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-border/);
  assert.match(utilityBlock!, /var\(--km-nav-util-hover-text/);

  // The dedicated rule must not fall back to the shared navbar text/active tokens.
  assert.doesNotMatch(utilityBlock!, /--km-nav-text/);
  assert.doesNotMatch(utilityBlock!, /--km-nav-active/);
});

test("every navbar utility control carries the dedicated utility class", () => {
  const header = read("src/components/SiteHeader.tsx");
  const bell = read("src/components/nav/NotificationBell.tsx");
  const cart = read("src/components/commerce/CartIndicator.tsx");
  const wishlist = read("src/components/commerce/WishlistIndicator.tsx");

  // One definition, applied to search, the account trigger, and the mobile
  // menu button. The old header spelled out four near-identical class
  // constants, which is how one of them ends up a different colour.
  assert.match(header, /const utilityClass = "site-nav-utility site-nav-control"/);
  /*
   * Discovery 4.0 removed the two magnifier buttons: the bar carries a real
   * search field now, and the mobile bar carries it on a second row. What is
   * left wearing the utility class is the account trigger and the mobile menu
   * button — so the count is the definition plus two, not plus four.
   */
  const utilityUses = header.match(/\butilityClass\b/g) ?? [];
  assert.ok(utilityUses.length >= 3, `expected the definition plus its controls; saw ${utilityUses.length}`);
  // The search field replaced them, and reads the same utility tokens rather
  // than inventing a fourth set of navbar colours.
  assert.match(header, /StorefrontSearch/);
  const searchCss = read("src/app/globals.css");
  const searchBlock = searchCss.slice(searchCss.indexOf(".storefront-search-form {"));
  assert.match(searchBlock.slice(0, 500), /var\(--km-nav-util-border/);
  assert.match(searchBlock.slice(0, 500), /var\(--km-nav-util-bg/);
  assert.match(header, /triggerClassName=\{`\$\{utilityClass\} site-nav-account`\}/);

  for (const [name, source] of [["bell", bell], ["cart", cart], ["wishlist", wishlist]] as const) {
    assert.match(source, /site-nav-utility/, `${name} must use the dedicated utility tokens`);
  }
  assert.match(cart, /site-nav-utility-badge/);
});

test("navbar utility controls do not derive their color from the shared secondary/accent token", () => {
  const header = read("src/components/SiteHeader.tsx");
  const bell = read("src/components/nav/NotificationBell.tsx");
  const accountMenu = read("src/components/nav/AccountMenu.tsx");

  // Changing the site's primary/accent colour must not recolour the header.
  const accentTokens = /brand-accent|amber-200|amber-300|amber-400|theme-accent-glow/;

  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const [name, source] of [
    ["header", header],
    ["bell", bell],
    ["account menu", accountMenu],
  ] as const) {
    assert.doesNotMatch(strip(source), accentTokens, `${name} must not hard-code an accent colour`);
  }

  // The sign-in call to action was a literal amber pill. It now reads the
  // badge tokens, so an operator who themes the navbar themes it too.
  assert.match(read("src/app/globals.css"), /\.site-nav-signin \{[^}]*var\(--km-nav-badge-bg/);
});
