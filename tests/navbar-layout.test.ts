import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { badgeCount, badgeLabel, MAX_BADGE_TEXT } from "../src/lib/navBadge.ts";
import {
  accountNav,
  allCustomerNavHrefs,
  isNavItemActive,
  primaryNav,
  secondaryNav,
  staffNavItems,
} from "../src/lib/navigation.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const header = read("src/components/SiteHeader.tsx");
const navMenu = read("src/components/nav/NavMenu.tsx");
const drawer = read("src/components/nav/MobileNavDrawer.tsx");
const accountMenu = read("src/components/nav/AccountMenu.tsx");
const bell = read("src/components/nav/NotificationBell.tsx");
const cart = read("src/components/commerce/CartIndicator.tsx");
const wishlist = read("src/components/commerce/WishlistIndicator.tsx");
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// Information architecture
//
// The header is ecommerce-first, and these assert it against the shared
// navigation module rather than against rendered markup — so a future edit that
// quietly reintroduces the forum hierarchy fails here rather than in review.
// ---------------------------------------------------------------------------

test("the primary navigation leads with what a customer can buy", () => {
  assert.equal(primaryNav[0].href, "/catalog", "Products must come first");
  assert.equal(primaryNav[0].label, "Products", "'Catalog' is the old vocabulary");
  assert.equal(primaryNav[1].href, "/orders/new", "custom work is the second thing this business sells");
  assert.ok(primaryNav.length <= 5, "a storefront header with six links is a forum masthead");
});

test("Community is available but not in the primary navigation", () => {
  const primary = primaryNav.map((item) => item.href);
  assert.ok(!primary.includes("/community"), "Community must not occupy prime ecommerce navigation");

  // Moved, not deleted. It must remain reachable from a customer surface.
  const secondary = secondaryNav.map((item) => item.href);
  assert.ok(secondary.includes("/community"), "Community must stay reachable from the More menu");
  assert.match(drawer, /secondaryNav\.map/, "and from the mobile drawer");
});

test("staff access is never in the customer link row", () => {
  const customer = allCustomerNavHrefs();
  assert.ok(!customer.some((href) => href.startsWith("/staff")), "a staff link in the link row reads as a store category");

  // It is a real destination for a real staff session, and absent otherwise.
  assert.equal(staffNavItems(false).length, 0);
  assert.equal(staffNavItems(true)[0].href, "/staff");

  // Rendered from inside the account menu and the drawer, not the bar.
  assert.match(accountMenu, /staffNavItems\(isStaff\)/);
  assert.match(drawer, /staffNavItems\(isStaff\)/);
  assert.doesNotMatch(
    header,
    /href="\/staff"/,
    "the bar itself must not carry a staff pill"
  );
});

test("desktop and mobile navigation cannot drift apart", () => {
  // The old header built the desktop bar from two arrays and hard-coded a
  // second copy of the same links in the mobile panel. They had already
  // diverged: the drawer offered no Wishlist and no Orders.
  for (const source of [header, drawer]) {
    assert.match(source, /from "@\/lib\/navigation"/, "both surfaces read the one module");
  }
  assert.match(header, /primaryNav\.map/);
  assert.match(drawer, /primaryNav\.map/);

  // No literal customer hrefs left hard-coded in the header's markup.
  for (const href of allCustomerNavHrefs()) {
    assert.doesNotMatch(
      header,
      new RegExp(`href="${href.replace(/\//g, "\\/")}"`),
      `${href} must come from the navigation module, not a literal in SiteHeader`
    );
  }
});

test("the mobile drawer reaches everything a phone user needs", () => {
  // The mobile bar deliberately carries only logo, search, cart and menu, so
  // every other destination has to be inside the drawer.
  for (const expected of ["/wishlist", "/orders", "/account", "/messages"]) {
    assert.ok(
      accountNav.some((item) => item.href === expected) || drawer.includes(`"${expected}"`),
      `${expected} must be reachable from the drawer`
    );
  }
});

test("active state distinguishes /orders from /orders?view=requests", () => {
  assert.equal(isNavItemActive({ href: "/orders" }, "/orders"), true);
  assert.equal(isNavItemActive({ href: "/orders?view=requests" }, "/orders", "?view=requests"), true);
  assert.equal(isNavItemActive({ href: "/orders?view=requests" }, "/orders", ""), false);
  // A prefix test would light the home link up on every page.
  assert.equal(isNavItemActive({ href: "/" }, "/catalog"), false);
  assert.equal(isNavItemActive({ href: "/" }, "/"), true);
  // A sibling route must not claim the parent's highlight.
  assert.equal(isNavItemActive({ href: "/catalog" }, "/catalogue"), false);
  assert.equal(isNavItemActive({ href: "/catalog" }, "/catalog/shift-knob"), true);
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * The pass-4 regression, still guarded. The bar was
 * `grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`, which forces the two side
 * columns to the same width; the utility cluster overflowed leftward over the
 * centred navigation. The logo moved left in this pass, which removes the
 * symmetric template entirely — but the invariant is worth stating.
 */
test("the navigation is the flexible column, not the utilities", () => {
  assert.match(header, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.doesNotMatch(header, /grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
});

test("the utility cluster declares that it does not compress", () => {
  // A compressed cart button is a cart button someone cannot press.
  assert.match(header, /flex shrink-0 items-center justify-end gap-2" data-testid="header-utilities"/);
});

test("an operator wordmark is bounded so it cannot push the navigation", () => {
  assert.match(header, /wordmarkUrl[\s\S]{0,300}max-w-32/);
});

test("one definition of the header height", () => {
  // The drawer offsets by it and the sticky purchase panel subtracts it.
  assert.match(css, /--km-header-height:\s*3\.75rem/);
  assert.match(css, /\[data-navigation-density="comfortable"\] \.site-header-inner \{ --km-header-height: 4\.25rem/);
  assert.match(css, /\.site-header-desktop,\s*\.site-header-mobile \{ height: var\(--km-header-height\)/);
});

test("the overflow split is CSS, not measurement", () => {
  // A measured overflow has to guess a width during server rendering and
  // correct it after mount: a hydration mismatch and a visible reflow.
  assert.doesNotMatch(header, /ResizeObserver/);
  assert.doesNotMatch(header, /offsetWidth[\s\S]{0,60}setState/);
});

// ---------------------------------------------------------------------------
// Menu semantics — one implementation, shared
// ---------------------------------------------------------------------------

test("every navbar menu is a real menu", () => {
  assert.match(navMenu, /aria-expanded=\{open\}/);
  assert.match(navMenu, /aria-haspopup="menu"/);
  assert.match(navMenu, /aria-controls=\{open \? menuId : undefined\}/);
  assert.match(navMenu, /role="menu"/);
  assert.match(navMenu, /aria-label=\{menuLabel\}/);
  for (const [name, source] of [["More menu", header], ["account menu", accountMenu]] as const) {
    assert.match(source, /role="menuitem"/, `${name} items must be menu items`);
    assert.match(source, /tabIndex=\{-1\}/, `${name} items are reached by arrow keys, not Tab`);
  }
});

test("keyboard navigation reads the items that were actually rendered", () => {
  // The first cut threaded an `itemProps(index)` callback through a render prop
  // and made each caller declare how many items it would render. That put a
  // hand-maintained count a hundred lines from the markup it described — the
  // account menu had to remember to add one for Sign out — and a wrong count
  // silently truncates arrow-key navigation.
  assert.match(navMenu, /querySelectorAll<HTMLElement>\('\[role="menuitem"\]'\)/);
  assert.doesNotMatch(navMenu, /itemCount/, "no hand-maintained count may return");
  for (const source of [header, accountMenu]) {
    assert.doesNotMatch(source, /itemCount=/);
  }
});

test("Escape closes a menu and returns focus to its trigger", () => {
  assert.match(navMenu, /event\.key === "Escape"/);
  assert.match(navMenu, /triggerRef\.current\?\.focus\(\)/);
  assert.match(navMenu, /document\.removeEventListener\("keydown", onKeyDown\)/, "the listener must be cleaned up");
  assert.match(navMenu, /document\.removeEventListener\("mousedown", onPointerDown\)/);
});

test("menus support arrow-key navigation and close on Tab out", () => {
  assert.match(navMenu, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  // Wrapping, so End→ArrowDown lands on the first item rather than nowhere.
  assert.match(navMenu, /% items\.length/);
  assert.match(navMenu, /event\.key === "Tab"/);
  // The trigger opens the menu on ArrowDown as well as Enter and Space.
  assert.match(navMenu, /event\.key === "ArrowDown" \|\| event\.key === "Enter"/);
});

test("a pointer-opened menu does not steal focus", () => {
  // Opening with the keyboard focuses the first item; clicking must not, or a
  // mouse user gets a focus ring they did not ask for.
  assert.match(navMenu, /focusFirstRef/);
  assert.match(navMenu, /if \(!open \|\| !focusFirstRef\.current\) return/);
});

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------

test("the mobile drawer is a dialog, not a collapsing div", () => {
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby="mobile-nav-title"/);
  // The old panel was a `max-h-96` transition, which silently clipped the list
  // once it grew past six links. Comments are stripped first — this file's own
  // prose explains that history and would otherwise match itself.
  const code = drawer.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /max-h-\d/);
});

test("the drawer escapes the header's transform via a portal", () => {
  // Found by measuring the panel in a browser, not by reading the markup. The
  // header carries `transition-transform` for auto-hide, and a transformed
  // ancestor becomes the containing block for `position: fixed` descendants
  // (CSS Transforms L1 §3). Rendered in place, the drawer's `inset: 0` resolved
  // against the 60px-tall bar: it painted 60px tall with its list clipped away.
  assert.match(drawer, /createPortal\(/);
  assert.match(drawer, /document\.body\s*\)/, "the portal target must be the body, not the header");
  // `document` does not exist during server rendering.
  assert.match(drawer, /typeof document === "undefined"\) return null/);

  // And the header must still be the thing that transforms, or the portal is
  // solving a problem that no longer exists and would be quietly removed.
  assert.match(header, /transition-transform/);
});

test("the drawer traps focus and restores it on close", () => {
  assert.match(drawer, /event\.key !== "Tab"/);
  assert.match(drawer, /last\.focus\(\)/);
  assert.match(drawer, /first\.focus\(\)/);
  assert.match(drawer, /triggerRef\.current\?\.focus\(\)/, "focus returns to the menu button");
  assert.match(drawer, /closeRef\.current\?\.focus\(\)/, "and moves in on open");
});

test("the page behind the drawer does not scroll or jump", () => {
  assert.match(drawer, /body\.style\.overflow = "hidden"/);
  assert.match(drawer, /body\.style\.top = `-\$\{scrollY\}px`/, "position:fixed alone loses the scroll offset");
  assert.match(drawer, /window\.scrollTo\(0, scrollY\)/, "and it must be restored on close");
});

test("the drawer is bounded by the visual viewport and clears the safe area", () => {
  const rule = css.match(/\.mobile-nav-panel\s*\{([^}]*)\}/);
  assert.ok(rule, "globals.css must define .mobile-nav-panel");
  // `dvh` rather than `vh`: mobile browsers shrink the viewport when their
  // toolbar appears, and `vh` would put the last item under it.
  assert.match(rule[1], /max-height:\s*100dvh/);
  assert.match(rule[1], /padding-bottom:\s*env\(safe-area-inset-bottom\)/);
  const scroll = css.match(/\.mobile-nav-scroll\s*\{([^}]*)\}/);
  assert.ok(scroll);
  assert.match(scroll[1], /overflow-y:\s*auto/, "a long list must be reachable, not clipped");
  assert.match(scroll[1], /overscroll-behavior:\s*contain/, "scrolling past the end must not scroll the page");
});

test("drawer rows meet the 44px touch target", () => {
  for (const selector of ["mobile-nav-item", "mobile-nav-close", "mobile-nav-search"]) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `globals.css must define .${selector}`);
    assert.match(rule[1], /(min-height|height):\s*2\.75rem/, `.${selector} must be at least 44px tall`);
  }
});

test("motion is opt-out, and the opt-out is CSS", () => {
  // A JS media-query branch has to resolve during server rendering, which is a
  // hydration mismatch waiting to happen.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.mobile-nav-panel/);
  assert.doesNotMatch(drawer, /prefers-reduced-motion/);
  assert.doesNotMatch(navMenu, /prefers-reduced-motion/);
});

// ---------------------------------------------------------------------------
// Count badges
// ---------------------------------------------------------------------------

test("counts are capped at 99+, not 9+", () => {
  assert.equal(badgeCount(1), "1");
  assert.equal(badgeCount(9), "9");
  assert.equal(badgeCount(12), "12");
  assert.equal(badgeCount(99), "99");
  assert.equal(badgeCount(100), "99+");
  assert.equal(badgeCount(4821), "99+");
  assert.equal(MAX_BADGE_TEXT, "99+");
});

test("a zero or missing count renders no bubble at all", () => {
  assert.equal(badgeCount(0), "");
  assert.equal(badgeCount(null), "");
  assert.equal(badgeCount(undefined), "");
  assert.equal(badgeCount(Number.NaN), "");
  assert.equal(badgeCount(-3), "", "a negative count is a bug upstream, not a bubble");
});

test("screen readers get the real number, not the capped text", () => {
  assert.equal(badgeLabel("Cart", 1), "Cart, 1 item");
  assert.equal(badgeLabel("Cart", 128), "Cart, 128 items");
  assert.equal(badgeLabel("Wishlist", 0), "Wishlist, 0 items");
});

test("every navbar count uses the one helper", () => {
  // Four copies of `count > 9 ? "9+" : count` is how one control ends up saying
  // "9+" beside another saying "12".
  for (const [name, source] of [["bell", bell], ["cart", cart], ["wishlist", wishlist]] as const) {
    assert.match(source, /badgeCount/, `${name} must use the shared helper`);
    assert.doesNotMatch(source, /> 9 \? "9\+"/, `${name} must not keep its own cap`);
  }
});

test("the counts moved into menus are still capped the same way", () => {
  // Messages and Notifications are printed beside their destination now rather
  // than on the bar, and the cap has to survive the move.
  for (const [name, source] of [["account menu", accountMenu], ["drawer", drawer]] as const) {
    assert.match(source, /> 99 \? "99\+"/, `${name} must cap at 99+`);
  }
});

test("the count bubble cannot shift the header when it loads", () => {
  // Counts arrive from a query and always land after the first paint.
  const rule = css.match(/\.site-nav-badge\s*\{([^}]*)\}/);
  assert.ok(rule, "globals.css must define .site-nav-badge");
  assert.match(rule[1], /position:\s*absolute/, "the bubble must not participate in layout");
  assert.match(rule[1], /min-width:\s*1\.35rem/, "the box is reserved at the width of 99+");
  assert.match(rule[1], /justify-content:\s*center/);
  assert.match(rule[1], /font-variant-numeric:\s*tabular-nums/, "digits must not jitter as the count changes");
  assert.match(rule[1], /pointer-events:\s*none/, "the bubble must not steal a click from its control");
});

test("the bubble is decorative because the control is already labelled", () => {
  for (const [name, source] of [["cart", cart], ["wishlist", wishlist]] as const) {
    assert.match(source, /site-nav-badge" aria-hidden="true"/, `${name} bubble must be aria-hidden`);
    assert.match(source, /aria-label=\{badgeLabel\(/, `${name} must carry the count in its accessible name`);
  }
  assert.match(bell, /aria-label=\{unreadCount \? `Notifications, \$\{unreadCount\} unread`/);
});

test("the unread dot is an ornament with a real name behind it", () => {
  // Messages moved off the bar, so the account trigger has to say what the dot
  // means rather than relying on the dot alone.
  assert.match(accountMenu, /site-nav-dot" aria-hidden="true"/);
  assert.match(accountMenu, /`Account menu for \$\{label\}, \$\{unreadTotal\} unread`/);
  const rule = css.match(/\.site-nav-dot\s*\{([^}]*)\}/);
  assert.ok(rule, "globals.css must define .site-nav-dot");
  assert.match(rule[1], /pointer-events:\s*none/);
});

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

test("nothing in the navbar hard-codes a theme colour", () => {
  const themable = css.slice(css.indexOf(".site-header-inner"), css.indexOf(".mobile-nav-signout"));
  const hexes = themable.match(/#[0-9a-f]{3,6}/gi) ?? [];
  // Every hex that survives must be a fallback inside a var(), which is what
  // keeps the bar readable if a token is ever missing.
  for (const hex of hexes) {
    const index = themable.indexOf(hex);
    const context = themable.slice(Math.max(0, index - 80), index);
    assert.match(context, /var\(--km-nav/, `${hex} must be a var() fallback, not a hard-coded colour`);
  }
});

test("the new navbar tokens reach the page", () => {
  const layout = read("src/app/layout.tsx");
  for (const token of [
    "--km-nav-hover-bg",
    "--km-nav-hover-text",
    "--km-nav-badge-bg",
    "--km-nav-badge-text",
    "--km-nav-mobile-bg",
    "--km-nav-mobile-text",
  ]) {
    assert.match(layout, new RegExp(`"${token}"`), `${token} must be published by the root layout`);
    assert.ok(css.includes(`var(${token}`), `${token} must be consumed by globals.css`);
  }
});

test("an existing Appearance configuration keeps working", async () => {
  const { normalizeSiteTheme, defaultSiteTheme } = await import("../src/theme/runtime.ts");
  // A theme_config saved before this pass has none of the new keys.
  const legacy = normalizeSiteTheme({ navigationBackground: "#111111", navigationText: "#eeeeee" });
  assert.equal(legacy.navigationBackground, "#111111", "existing values survive");
  assert.equal(legacy.navigationHoverBackground, defaultSiteTheme.navigationHoverBackground, "new keys fall back");
  assert.equal(legacy.navigationBadgeBackground, defaultSiteTheme.navigationBadgeBackground);
  assert.equal(legacy.navigationMobileText, defaultSiteTheme.navigationMobileText);
  // And a garbage value does not become a CSS injection.
  const hostile = normalizeSiteTheme({ navigationBadgeBackground: "red; } body { display:none" });
  assert.equal(hostile.navigationBadgeBackground, defaultSiteTheme.navigationBadgeBackground);
});
