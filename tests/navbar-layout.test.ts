import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { badgeCount, badgeLabel, MAX_BADGE_TEXT } from "../src/lib/navBadge.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const header = read("src/components/SiteHeader.tsx");
const cart = read("src/components/commerce/CartIndicator.tsx");
const wishlist = read("src/components/commerce/WishlistIndicator.tsx");
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// The overlap itself
// ---------------------------------------------------------------------------

/**
 * The regression. The desktop bar was
 * `grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`, which forces the two side
 * columns to the *same* width. Measured at 1280 with a signed-in staff account,
 * the search button needed 85px and the utility cluster needed 495px — and both
 * were given 306px. The cluster is `justify-end` and its pills do not shrink, so
 * the extra 190px overflowed leftward, straight over the centred navigation.
 * Nothing clipped it and the page never gained a horizontal scrollbar, so it
 * read as controls stacked on each other rather than as overflow.
 */
test("the utility cluster is never forced to mirror the search column", () => {
  assert.match(
    header,
    /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/,
    "utilities and search must size to their own content; the navigation is the flexible column"
  );
  assert.doesNotMatch(
    header,
    /grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/,
    "the symmetric template is what caused the overlap"
  );
});

test("the utility cluster declares that it does not compress", () => {
  // A compressed cart button is a cart button someone cannot press.
  assert.match(header, /className="flex shrink-0 items-center justify-end gap-2 xl:gap-3" data-testid="header-utilities"/);
});

test("the header is given more room exactly where it grows", () => {
  // `2xl` turns on the Ctrl+K chip, a wider account name, and the wordmark:
  // 1292px of content inside a 1240px container, measured at 1920.
  assert.match(header, /max-w-7xl px-4 xl:px-5 2xl:max-w-\[94rem\]/);
});

test("an operator wordmark is bounded so it cannot reopen the overflow", () => {
  assert.match(header, /wordmarkUrl[\s\S]{0,200}max-w-28/);
  assert.doesNotMatch(header, /wordmarkUrl[\s\S]{0,200}max-w-36/);
});

// ---------------------------------------------------------------------------
// Priority and the overflow menu
// ---------------------------------------------------------------------------

test("navigation has explicit priority levels", () => {
  assert.match(header, /\{ href: "\/catalog", label: "Catalog", primary: true \}/);
  assert.match(header, /\{ href: "\/projects", label: "Projects", primary: true \}/);
  for (const secondary of ["/about", "/capabilities", "/contact", "/community"]) {
    assert.match(
      header,
      new RegExp(`href: "${secondary}", label: "[A-Za-z]+", primary: false`),
      `${secondary} must be marked secondary so it can step into the overflow menu`
    );
  }
});

test("secondary links and the More menu are driven by one breakpoint", () => {
  // Exactly one of the two shows a given link, so nothing is listed twice and
  // nothing disappears entirely.
  assert.match(header, /l\.primary \? "" : " hidden xl:inline-flex"/);
  assert.match(header, /className="relative xl:hidden"/, "the More menu is the inverse of the inline links");
});

test("the overflow menu contains exactly the links that leave the bar", () => {
  assert.match(
    header,
    /\[\.\.\.leftLinks, \.\.\.rightLinks\]\.filter\(\(link\) => !link\.primary\)/,
    "the menu is derived from the same list, not maintained separately"
  );
});

test("the overflow split is CSS, not measurement", () => {
  // A measured overflow has to guess a width during server rendering and
  // correct it after mount: a hydration mismatch and a visible reflow.
  assert.doesNotMatch(header, /ResizeObserver/);
  assert.doesNotMatch(header, /offsetWidth[\s\S]{0,60}setState/);
});

test("the More menu is a real menu", () => {
  const menu = header.slice(header.indexOf("function NavOverflowMenu"), header.indexOf("function NotificationBell"));
  assert.match(menu, /aria-expanded=\{open\}/);
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /aria-controls=\{open \? menuId : undefined\}/);
  assert.match(menu, /role="menu"/);
  assert.match(menu, /aria-label="More navigation"/);
  assert.match(menu, /role="menuitem"/);
  assert.match(menu, /aria-current=\{isActive\(item\.href\) \? "page" : undefined\}/);
});

test("Escape closes the overflow menu and returns focus to its trigger", () => {
  const menu = header.slice(header.indexOf("function NavOverflowMenu"), header.indexOf("function NotificationBell"));
  assert.match(menu, /event\.key !== "Escape"/);
  assert.match(menu, /triggerRef\.current\?\.focus\(\)/, "focus must land where the menu was opened from");
  assert.match(menu, /useOutsideClick\(wrapRef, \(\) => setOpen\(false\)\)/);
  assert.match(menu, /document\.removeEventListener\("keydown", onKeyDown\)/, "the listener must be cleaned up");
});

test("the overflow trigger shows when it holds the current page", () => {
  const menu = header.slice(header.indexOf("function NavOverflowMenu"), header.indexOf("function NotificationBell"));
  assert.match(menu, /const containsCurrent = items\.some\(\(item\) => isActive\(item\.href\)\)/);
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
  for (const [name, source] of [["header", header], ["cart", cart], ["wishlist", wishlist]] as const) {
    assert.match(source, /badgeCount/, `${name} must use the shared helper`);
    assert.doesNotMatch(source, /> 9 \? "9\+"/, `${name} must not keep its own cap`);
  }
  assert.equal((header.match(/badgeCount\(unreadCount\)/g) ?? []).length, 2, "both bells");
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
  assert.match(header, /aria-label=\{unreadCount \? `Notifications, \$\{unreadCount\} unread`/);
  assert.match(header, /aria-label=\{unreadCount \? `Messages, \$\{unreadCount\} unread`/);
});
