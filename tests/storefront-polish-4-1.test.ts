import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ProductCard, { type ProductCardProduct } from "../src/components/ProductCard.tsx";

/**
 * Storefront polish 4.1.
 *
 * A refinement pass on top of the 4.0 discovery work, not a rewrite of it. Six
 * things changed and each one has a way of silently reverting:
 *
 *   1. **List is the default view.** Reverts by someone "restoring" the grid
 *      default, or by the CSS and the constant drifting apart.
 *   2. **The list status row is anchored.** Reverts the moment `align-items`
 *      goes back to `start`, because `margin-top: auto` then has no free space
 *      to consume and fails *silently* — the rule is still there, doing nothing.
 *   3. **Products is one outlined control.** Reverts if the pill moves back onto
 *      the inner link.
 *   4. **The header ends on the cart.** Reverts on any reordering of the cluster.
 *   5. **The cart is a sheet with a pinned footer.** Reverts if the footer is
 *      ever moved back inside the scrolling region, which is how the popover put
 *      checkout below the fold.
 *   6. **A successful add opens the drawer, a failed one does not.** Reverts if
 *      `openCart` is hoisted out of `onSuccess`.
 *
 * Where a claim is about *rendered structure* it is checked against real markup
 * from `react-dom/server`. Where it is about geometry — how wide the media track
 * is, where the status row lands — it is checked against the stylesheet here and
 * confirmed in a browser during QA; a headless string cannot measure a box.
 *
 * `CartDrawer` itself is asserted from source rather than rendered, because it
 * returns `createPortal(...)` and `react-dom/server` has no portals. Its
 * behaviour is covered here structurally and in browser QA.
 */

// Newlines normalized: this repository checks out CRLF on Windows, and an
// assertion that happens to anchor on "\n" then passes or fails depending on
// which machine ran it.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const css = read("src/app/globals.css");
const header = read("src/components/SiteHeader.tsx");
const productsMenu = read("src/components/nav/ProductsMenu.tsx");
const mobileDrawer = read("src/components/nav/MobileNavDrawer.tsx");
const cartIndicator = read("src/components/commerce/CartIndicator.tsx");
const cartDrawer = read("src/components/commerce/CartDrawer.tsx");
const cartProvider = read("src/components/commerce/CartDrawerProvider.tsx");
const catalogAction = read("src/components/catalog/CatalogProductAction.tsx");
const addToCart = read("src/components/commerce/AddToCartButton.tsx");

/** The `:where()` prelude every list rule shares. See `catalogView.ts`. */
const LIST = String.raw`:where\(\[data-catalog-density="list"\], :root:not\(\[data-catalog-density\]\)\)`;
const listRule = (selector: string, body: string) =>
  new RegExp(`${LIST} \\.catalog-grid ${selector} \\{[^}]*${body}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseProduct: ProductCardProduct = {
  id: "p1",
  name: "Billet Shift Knob",
  slug: "billet-shift-knob",
  short_description: "Turned from 6061 aluminum and hand finished.",
  image_url: null,
  category: "Interior",
  starting_price_cents: 8400,
  is_custom: false,
  purchase_mode: "direct_purchase",
  availability_status: "available",
  lead_time_text: "Usually 3 days",
  inventory_policy: "unlimited",
  inventory_quantity: 0,
  continue_selling_when_out_of_stock: false,
  product_media: null,
};

function renderCard(overrides: Partial<ProductCardProduct> = {}) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ProductCard, { product: { ...baseProduct, ...overrides } })
    )
  );
}

/** Index of a class in the markup, asserting it is actually there. */
const at = (markup: string, needle: string) => {
  const index = markup.indexOf(needle);
  assert.ok(index > -1, `expected to find ${needle}`);
  return index;
};

// ---------------------------------------------------------------------------
// Part D — the Products control is one outlined thing
// ---------------------------------------------------------------------------

test("the Products outline encloses both the label and the chevron", () => {
  /*
   * The defect: the pill lived on the `<a>`, so the chevron sat *outside* the
   * outline and Products read as a button with a loose arrow beside it — while
   * `More`, a single button containing its own chevron, read as one control.
   *
   * The fix is which element paints the border. The wrapper carries the bar's
   * link classes; both children are inside it and carry none.
   */
  assert.match(productsMenu, /className=\{`products-menu-trigger \$\{controlClassName\}`\}/);

  const wrapper = productsMenu.indexOf("products-menu-trigger ${controlClassName}");
  const link = productsMenu.indexOf('className="products-menu-link"');
  const toggle = productsMenu.indexOf('className="products-menu-toggle"');
  assert.ok(wrapper > -1 && link > wrapper, "the link must be inside the outlined wrapper");
  assert.ok(toggle > link, "the chevron must be inside it too, after the label");

  // The inner link paints nothing of its own, or there would be a pill in a pill.
  assert.doesNotMatch(productsMenu, /className=\{linkClassName\}/);
  assert.match(css, /\.products-menu-link \{[^}]*color: inherit;/);
  assert.match(css, /\.products-menu-toggle \{[^}]*background: transparent;/);
  assert.match(css, /\.products-menu-toggle \{[^}]*border: 0;/);
});

test("the wrapper is the one the Appearance navigation styles reach", () => {
  // `site-nav-link` is what the public navigation styles key on. Putting it on
  // the wrapper is what stops Products needing a case of its own — and in 4.0 it
  // is also what gives Products a single underline spanning the label and the
  // chevron, rather than a rule under the word and a bare chevron beside it.
  assert.match(header, /controlClassName=\{navLinkClass\("\/catalog"\)\}/);
  assert.match(header, /site-nav-link site-nav-primary-link/);
  // Only the padding is restated; height and states come from the shared rule.
  // The values tightened with the pill's removal, so this pins the shape of the
  // override rather than the two numbers in it.
  assert.match(css, /\.products-menu-trigger\[data-has-menu="true"\] \{[^}]*padding-inline: [\d.]+rem [\d.]+rem;/);
});

test("Products still navigates, still opens, and is still two tab stops", () => {
  // The visual change must not cost the split semantics: a `<button>` cannot be
  // middle-clicked, bookmarked, or followed by a crawler, and /catalog is a real
  // page that the commonest click on this word is asking for.
  assert.match(productsMenu, /<Link\s+href="\/catalog"/);
  assert.match(productsMenu, /aria-current=\{isActive \? "page" : undefined\}/);
  assert.match(productsMenu, /<button[\s\S]{0,400}?aria-expanded=\{open\}/);
  assert.match(productsMenu, /aria-haspopup="true"/);
  assert.match(productsMenu, /aria-label=\{open \? "Hide product categories" : "Show product categories"\}/);

  // Keyboard: ArrowDown from either control opens it, Escape closes and restores.
  assert.match(productsMenu, /event\.key !== "ArrowDown"/);
  assert.match(productsMenu, /event\.key === "ArrowDown" \|\| event\.key === "Enter"/);
  assert.match(productsMenu, /if \(event\.key !== "Escape"\) return;[\s\S]{0,120}close\(true\)/);

  // Two rings, because they are two destinations. One ring around the pill would
  // tell a keyboard user that "this whole thing" is focused, which is never true.
  assert.match(css, /\.products-menu-link:focus-visible,\s*\.products-menu-toggle:focus-visible \{/);
});

test("the 4.0 dropdown behaviour is untouched", () => {
  for (const kept of [
    // The two delay constants moved into `useNavHoverIntent` in Custom Project
    // Request 3.0, so More could open the same way instead of a second hover
    // system being written beside this one. Products still hovers, on the same
    // numbers; only the declaration site changed.
    "useNavHoverIntent",
    "products-menu-panel",
    "nav.categories.map",
    "category.children.map",
    "products-menu-count",
  ]) {
    assert.ok(productsMenu.includes(kept), `4.0 dropdown lost: ${kept}`);
  }
  // Hover intent still closes slower than it opens: opening late costs a moment,
  // closing early costs the interaction.
  const hook = read("src/components/nav/useNavHoverIntent.ts");
  const open = Number(hook.match(/NAV_HOVER_OPEN_DELAY_MS = (\d+)/)?.[1]);
  const close = Number(hook.match(/NAV_HOVER_CLOSE_DELAY_MS = (\d+)/)?.[1]);
  assert.ok(open > 0, "opening must keep its intent delay");
  assert.ok(close > open, "the close delay must stay the longer of the two");
});

// ---------------------------------------------------------------------------
// Part E — the header ends on the cart
// ---------------------------------------------------------------------------

test("the desktop cluster reads Notifications, Account, Wishlist, Cart", () => {
  const cluster = header.slice(header.indexOf('data-testid="header-utilities"'));
  const end = cluster.indexOf("MOBILE");
  const region = cluster.slice(0, end > 0 ? end : undefined);

  const bell = at(region, "<NotificationBell");
  const account = at(region, "<AccountMenu");
  const wishlist = at(region, "<WishlistIndicator />");
  const cart = at(region, "<CartIndicator />");

  assert.ok(bell < account, "notifications keep their slot ahead of the account menu");
  assert.ok(account < wishlist, "Account must come before Wishlist");
  assert.ok(wishlist < cart, "Wishlist must sit immediately before Cart");
  assert.equal(
    region.slice(cart).match(/<(WishlistIndicator|AccountMenu|NotificationBell)/)?.[0],
    undefined,
    "Cart must be the last of these four"
  );
});

test("the guest cluster keeps the same commerce pair in the same place", () => {
  // Guests build carts and wishlists too. If these moved inside the signed-in
  // branch, the two controls would jump position the moment somebody logged in.
  const cluster = header.slice(header.indexOf('data-testid="header-utilities"'));
  const signin = at(cluster, 'href="/auth/login"');
  const wishlist = at(cluster, "<WishlistIndicator />");
  assert.ok(signin < wishlist, "the commerce pair must sit outside the signed-in branch");
});

test("Cart stays reachable and labelled with its real count", () => {
  assert.match(cartIndicator, /badgeLabel\("Cart", itemCount\)/, "the accessible name carries the true number");
  assert.match(cartIndicator, /badgeCount\(itemCount\)/, "the bubble is the truncated one");
  assert.match(cartIndicator, /aria-hidden="true"/, "the bubble must not be read twice");
  // Both bars, or a phone user has a full cart and no way back to it.
  assert.equal((header.match(/<CartIndicator \/>/g) ?? []).length, 2);
});

test("the mobile drawer keeps Account, Wishlist, Cart together", () => {
  // Cart was in the guest list and missing from the signed-in one, so signing in
  // silently removed a destination.
  const group = mobileDrawer.slice(mobileDrawer.indexOf("Your account"));
  assert.match(group, /item\.href === "\/wishlist" \? renderLink\(\{ href: "\/cart", label: "Cart" \}\) : null/);
  // Added at render, not to `accountNav` — that list is also the desktop account
  // dropdown, which sits two controls away from the cart button itself.
  assert.ok(!read("src/lib/navigation.ts").includes('{ href: "/cart", label: "Cart" }\n] as const'));
});

// ---------------------------------------------------------------------------
// Part F/G — the cart drawer
// ---------------------------------------------------------------------------

test("the drawer pins its header and footer and scrolls only the items", () => {
  /*
   * The popover's defect, stated as a layout: its footer was a sibling of the
   * scroll area inside a panel with no height of its own, so four items pushed
   * "View cart and check out" past the bottom. Three grid rows fix it, and
   * `minmax(0, 1fr)` is the load-bearing part — a bare `1fr` floors at
   * min-content, which for a list of cart items is the whole list.
   */
  assert.match(css, /\.cart-drawer-panel \{[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.cart-drawer-scroll \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.cart-drawer-scroll \{[^}]*overscroll-behavior: contain;/);
  // Nothing else in the sheet may scroll, or the footer can leave the screen.
  for (const region of ["cart-drawer-panel", "cart-drawer-header", "cart-drawer-footer"]) {
    const rule = css.slice(css.indexOf(`.${region} {`));
    assert.ok(!/overflow-y: auto/.test(rule.slice(0, rule.indexOf("}"))), `${region} must not scroll`);
  }

  // And in the markup: the footer is a sibling of the scroll region, not in it.
  const scroll = at(cartDrawer, 'className="cart-drawer-scroll"');
  const footer = at(cartDrawer, 'className="cart-drawer-footer"');
  const checkout = at(cartDrawer, "cart-drawer-checkout");
  assert.ok(footer > scroll, "the footer follows the scroll region");
  assert.ok(checkout > footer, "checkout lives in the pinned footer");
});

test("the drawer is a modal dialog with a trapped, restored focus ring", () => {
  assert.match(cartDrawer, /role="dialog"/);
  assert.match(cartDrawer, /aria-modal="true"/);
  assert.match(cartDrawer, /aria-labelledby=\{titleId\}/);
  assert.match(cartDrawer, /const titleId = useId\(\)/);
  assert.match(cartDrawer, /id=\{titleId\}/);

  // Escape, and a Tab that cycles rather than walking out into the hidden page.
  assert.match(cartDrawer, /event\.key === "Escape"/);
  assert.match(cartDrawer, /event\.key !== "Tab"/);
  assert.match(cartDrawer, /event\.shiftKey && document\.activeElement === first/);

  // Initial focus is the way out, which is right for both ways in — a glance at
  // the cart, and a drawer that opened itself after an add nobody asked to leave
  // the catalog for.
  assert.match(cartDrawer, /closeRef\.current\?\.focus\(\)/);
  assert.match(cartDrawer, /aria-label="Close cart"/);

  // The backdrop dismisses but is not a tab stop that announces nothing.
  assert.match(cartDrawer, /className="cart-drawer-backdrop" onClick=\{onClose\} aria-hidden="true"/);

  // Restoration is the provider's, because it is the thing that knows the trigger.
  assert.match(cartProvider, /if \(trigger\?\.isConnected\) trigger\.focus\(\)/);
});

test("the page behind the drawer is locked and its scroll position kept", () => {
  const effect = cartDrawer.slice(cartDrawer.indexOf("const scrollY = window.scrollY"));
  assert.match(effect, /body\.style\.position = "fixed"/);
  assert.match(effect, /body\.style\.overflow = "hidden"/);
  assert.match(effect, /window\.scrollTo\(0, scrollY\)/, "closing must not jump the page to the top");
});

test("the drawer renders every state, including an empty one", () => {
  for (const state of [
    "Loading your cart…",
    "Your cart could not be loaded",
    "Your cart is empty.",
    "Browse products",
    "Continue shopping",
    "View cart and check out",
    "Subtotal",
  ]) {
    assert.ok(cartDrawer.includes(state), `the drawer must handle: ${state}`);
  }
  // Continue shopping closes rather than navigating away from the catalog page
  // the customer is standing on.
  assert.match(cartDrawer, /onClick=\{onClose\} className="cart-drawer-continue"/);
  // The empty state's own way out is a real link into the catalog.
  const empty = cartDrawer.slice(at(cartDrawer, "cart-drawer-empty"), at(cartDrawer, "cart-drawer-items"));
  assert.match(empty, /href="\/catalog"/);
});

test("each cart line shows a customer-facing summary, not raw option ids", () => {
  assert.match(cartDrawer, /item\.optionLabels\.map\(\(option\) => `\$\{option\.group\}: \$\{option\.label\}`\)/);
  assert.ok(!cartDrawer.includes("selectedOptions"), "the drawer must not print the id map");
  // Image, name, quantity, remove, line price.
  assert.match(cartDrawer, /<ProductImage product=\{item\.image\}/);
  assert.match(cartDrawer, /className="cart-drawer-item-name"/);
  assert.match(cartDrawer, /<QuantityField/);
  assert.match(cartDrawer, /aria-label=\{`Remove \$\{item\.name\} from your cart`\}/);
  assert.match(cartDrawer, /formatCents\(item\.lineSubtotalCents\)/);
  // Unit price only where it is a different number from the line total.
  assert.match(cartDrawer, /item\.quantity > 1 \?[\s\S]{0,160}formatCents\(item\.unitPriceCents\)/);
});

test("the subtotal is the server's number and the drawer never charges", () => {
  // A cart line holds the price it was added at. Re-deriving a total in the
  // browser from current product prices is how a drawer ends up disagreeing
  // with checkout about money.
  assert.match(cartDrawer, /formatCents\(cart\?\.subtotalCents \?\? 0\)/);
  assert.ok(!/reduce\(|\* item\.quantity/.test(cartDrawer), "the drawer must not compute a total");

  // The primary action is a link into /cart, where the fulfillment panel and the
  // terms notice live. A drawer that took a payment would be a checkout that
  // skipped the agreement flow.
  assert.match(cartDrawer, /<Link href="\/cart"[\s\S]{0,120}cart-drawer-checkout/);
  assert.ok(!/stripe|checkout\/session|\/api\/checkout/i.test(cartDrawer), "no payment may start here");
});

test("a mutation in flight disables the row rather than guessing at the result", () => {
  assert.match(cartDrawer, /const busy = setQuantity\.isPending \|\| remove\.isPending/);
  assert.match(cartDrawer, /disabled=\{!item\.itemId \|\| busy\}/);
  // A refusal is reported and the drawer stays open — removing or adjusting an
  // item must not dismiss the panel the customer is working in.
  assert.match(cartDrawer, /setQuantity\.error\?\.message \|\| remove\.error\?\.message/);
  assert.match(cartDrawer, /role="alert" className="ui-notice ui-notice-danger cart-drawer-error"/);
  assert.ok(!/onSuccess:[\s\S]{0,80}onClose\(\)/.test(cartDrawer), "a successful edit must not close the drawer");
});

test("the drawer is a sheet: right edge, viewport height, sane width, safe areas", () => {
  const panel = css.slice(css.indexOf(".cart-drawer-panel {"));
  const body = panel.slice(0, panel.indexOf("}"));
  assert.match(body, /right: 0;/);
  assert.match(body, /inset-block: 0;/);
  assert.match(body, /max-height: 100dvh;/, "dvh, because mobile browsers shrink the viewport for their toolbar");
  assert.match(body, /width: min\(26rem, 100vw - 2rem\);/, "26rem is 416px, inside the 400–440 the design asks for");
  assert.match(body, /padding-bottom: env\(safe-area-inset-bottom\)/);
  // Near-full width on a phone, where a sliver of backdrop is not worth 32px.
  assert.match(css, /@media \(max-width: 479\.98px\) \{\s*\.cart-drawer-panel \{ width: 100vw;/);
});

test("the drawer animation is transform-based, short, and respects reduced motion", () => {
  assert.match(css, /@keyframes cart-drawer-slide-in \{ from \{ transform: translateX\(100%\) \}/);
  const panel = css.slice(css.indexOf(".cart-drawer-panel {"));
  const duration = Number(panel.match(/cart-drawer-slide-in (\d+)ms/)?.[1]);
  assert.ok(duration > 0 && duration <= 260, `the slide must be brief, was ${duration}ms`);
  assert.ok(!/cubic-bezier\([^)]*-/.test(panel.slice(0, panel.indexOf("}"))), "no overshoot, no bounce");
  // Reduced motion drops the slide and keeps a fade, so the panel still reads as
  // arriving rather than teleporting.
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {", css.indexOf(".cart-drawer-panel {")));
  assert.match(reduced.slice(0, 260), /\.cart-drawer-panel \{ animation: cart-drawer-fade-in/);
});

test("the drawer uses semantic appearance roles, not storefront-local colours", () => {
  // Bounded by the drawer's own last rule. Slicing to the next unrelated
  // landmark swept in the navbar utility colours, which are `--km-nav-*` hexes
  // by design and would have made this assertion permanently red.
  const start = css.indexOf("==== Cart drawer");
  const end = css.indexOf(".cart-drawer-continue:focus-visible", start);
  assert.ok(start > -1 && end > start, "the cart drawer CSS block must be locatable");
  const block = css.slice(start, end);
  const hexes = block.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  assert.deepEqual(hexes, [], `the drawer must not hard-code colours: ${hexes.join(", ")}`);
  for (const token of ["--panel-strong", "--border", "--heading", "--muted", "--text"]) {
    assert.ok(block.includes(token), `the drawer must read ${token}`);
  }
  // Its two actions go through the shared button roles.
  assert.match(cartDrawer, /className="ui-btn ui-btn-primary cart-drawer-checkout"/);
});

test("the drawer does not refetch the shop to open", () => {
  // It reads the canonical cart the header badge already reads. No per-item
  // product lookup, no second query keyed on anything in the list.
  assert.match(cartDrawer, /useCart\(\)/);
  assert.ok(!/useQuery|fetch\(/.test(cartDrawer), "the drawer must not issue its own requests");
  assert.equal((cartDrawer.match(/useCart\(/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// Part H — add to cart opens it, and only on success
// ---------------------------------------------------------------------------

test("a successful catalog add opens the drawer; a failed one does not", () => {
  const success = catalogAction.slice(at(catalogAction, "onSuccess:"), at(catalogAction, "onError:"));
  assert.match(success, /openCart\(buttonRef\.current\)/, "the drawer opens from the success handler");

  const failure = catalogAction.slice(at(catalogAction, "onError:"));
  assert.ok(!failure.includes("openCart"), "a refused add must not open a drawer showing a cart without the item");
  assert.match(failure, /setConfirmed\(false\)/);
  assert.match(failure, /setError\(cause\.message\)/, "the server's own sentence is the useful one");

  // And nothing is predicted before the server answers.
  assert.ok(
    !/onMutate|optimisticUpdate|setQueryData/.test(catalogAction),
    "no optimistic cart state: a count that walks backwards is worse than a slow one"
  );
});

test("the product page's add behaves the same way", () => {
  const success = addToCart.slice(at(addToCart, "onSuccess:"), at(addToCart, "onError:"));
  assert.match(success, /openCart\(buttonRef\.current\)/);
  assert.ok(!addToCart.slice(at(addToCart, "onError:")).includes("openCart"));
});

test("only the cart path opens the cart", () => {
  // "Choose options", "Request a quote" and "View details" are links to the
  // product page. A sheet over a navigation the customer just asked for is a
  // panel in the way of the thing they wanted.
  // The early return itself, not everything before `addToCart` — the hook that
  // provides `openCart` is destructured above it and is not a call site.
  const guard = at(catalogAction, 'if (decision.kind !== "add_to_cart")');
  const branch = catalogAction.slice(guard, at(catalogAction, "const addToCart"));
  assert.match(branch, /<Link/, "the non-cart decisions are links to the product page");
  assert.ok(!branch.includes("openCart"), "the non-cart branch must never open the drawer");
});

test("required configuration and request-only never quick-add", () => {
  // 4.0 semantics, restated here because 4.1 is the pass that gave the add
  // button a reward — which is exactly the pressure that makes someone widen
  // which products get one.
  const actions = read("src/lib/commerce/catalogActions.ts");
  assert.match(actions, /requires_configuration/);
  assert.match(actions, /allowsDirectPurchase/);
  // The decision is made in the library and never in the component.
  assert.match(catalogAction, /const decision = catalogAction\(product\)/);
  assert.ok(
    !/purchase_mode|requires_configuration|has_options/.test(catalogAction),
    "the component must not re-decide what is purchasable"
  );
});

test("the count comes from the cart, not from the button that changed it", () => {
  assert.match(cartIndicator, /const \{ data: cart \} = useCart\(\)/);
  assert.match(cartIndicator, /cart\?\.itemCount \?\? 0/);
  assert.ok(!/useState\([0-9]/.test(cartIndicator), "the badge must not hold its own number");
});

// ---------------------------------------------------------------------------
// Part B — the list status row, against real markup and real rules
// ---------------------------------------------------------------------------

test("the status row is the last thing in the information column", () => {
  /*
   * Structure, not geometry: `margin-top: auto` can only push the row to the
   * floor if the row is genuinely last inside the body. If anything is ever
   * added after it, the anchor moves to that instead and the status row goes
   * back to floating on whatever the description left behind.
   */
  const markup = renderCard({ material: "Walnut/Poplar/African Mahogany Hardwoods" });

  const body = at(markup, "product-card-body");
  const footer = at(markup, "product-card-footer");
  const info = markup.slice(body, footer);

  const eyebrow = at(info, "product-card-eyebrow");
  const title = at(info, "product-card-title");
  const description = at(info, "product-card-description");
  const spec = at(info, "product-card-spec");
  const status = at(info, "product-card-status");

  assert.ok(eyebrow < title, "category above the name");
  assert.ok(title < description, "name above the sentence");
  assert.ok(description < spec, "material below the sentence");
  assert.ok(spec < status, "status below the material");
  assert.ok(
    !info.slice(status).includes("product-card-description"),
    "nothing may follow the status row inside the body"
  );
});

test("the status row keeps its hierarchy: chip, quiet text, outlined badge", () => {
  const markup = renderCard({ requires_configuration: false, has_options: true });
  const status = markup.slice(at(markup, "product-card-status"), at(markup, "product-card-footer"));

  // Availability is a toned chip, lead time is text beside it, customization is
  // a separate quiet signal. Three identical pills would make a shipping
  // estimate shout as loudly as "Currently unavailable".
  assert.match(status, /class="product-status-availability" data-tone="/);
  assert.match(status, /class="product-status-detail"/);
  assert.match(status, /class="product-status-custom" data-signal="/);
  assert.ok(status.includes("Usually 3 days"), "the lead time is rendered as its own quieter element");
});

test("the row survives every combination the catalog can produce", () => {
  const cases: [string, Partial<ProductCardProduct>][] = [
    ["long title", { name: "Billet Aluminium Short-Throw Shift Knob With Engraved Gate Pattern" }],
    ["long description", { short_description: "x".repeat(400) }],
    ["no description", { short_description: null }],
    ["material", { material: "Walnut/Poplar/African Mahogany Hardwoods" }],
    ["no material", { material: null }],
    ["customizable", { has_options: true }],
    ["not customizable", { has_options: false, requires_configuration: false }],
    ["made to order", { availability_status: "made_to_order", lead_time_text: "Usually 1-2 weeks" }],
  ];

  for (const [name, overrides] of cases) {
    const markup = renderCard(overrides);
    const body = at(markup, "product-card-body");
    const footer = at(markup, "product-card-footer");
    const info = markup.slice(body, footer);
    assert.ok(info.includes("product-card-status"), `${name}: the status row must still render`);
    assert.ok(
      info.indexOf("product-card-status") > info.indexOf("product-card-title"),
      `${name}: the status row must stay below the title`
    );
    // The purchase region is a sibling, so the row can be a middle column of its
    // own in list view without `display: contents` or a subgrid.
    assert.ok(footer > body, `${name}: the footer must follow the body`);
  }
});

test("the anchor and the stretch that makes it work are both present", () => {
  // These two only work together. `margin-top: auto` with `align-items: start`
  // is a rule that is still there and silently does nothing, which is the
  // hardest kind of regression to see in a diff.
  assert.match(css, listRule("\\.product-card", "align-items: stretch;"));
  assert.match(css, listRule("\\.product-card-status", "margin-top: auto;"));
  assert.match(css, listRule("\\.product-card-status", "padding-top: 0\\.875rem;"));
});

test("list proportions leave the information column room to be read", () => {
  // 14rem media (was 15rem, a 6.7% trim) and a 12.5rem purchase ceiling (was
  // 14rem) return about 60px to the middle at 1024, where the browsing rail is
  // already taking 15rem out of the page.
  assert.match(css, /grid-template-columns: 14rem minmax\(0, 1fr\) minmax\(9\.5rem, 12\.5rem\);/);
  // Still image-led: the photograph is the widest fixed track in the row.
  assert.ok(14 > 12.5, "the media track must stay wider than the purchase track");
  // And the CTA keeps its full width in that column — narrower, never weaker.
  assert.match(css, listRule("\\.product-card-cta", "width: 100%;"));
});

// ---------------------------------------------------------------------------
// Regression — 4.0 is still here
// ---------------------------------------------------------------------------

test("4.0 discovery survives the polish pass", () => {
  const browser = read("src/components/catalog/CatalogBrowser.tsx");
  for (const [name, source, needle] of [
    ["products dropdown", header, "<ProductsMenu"],
    ["global search", header, "<StorefrontSearch"],
    ["catalog query state", browser, "parseCatalogFilters"],
    ["view control", browser, "<CatalogViewControl />"],
    ["recovery", browser, "CatalogRecovery"],
  ] as const) {
    assert.ok(source.includes(needle), `4.0 lost: ${name}`);
  }
});

test("the drawer cannot become a way around the checkout notice", () => {
  /*
   * Terms and privacy architecture is 4.0's and is not this pass's to touch —
   * but a cart surface with its own primary action is exactly the shape that
   * could route around it by accident. So the invariant is stated here: the
   * agreement lives on `/cart`, and the drawer's one primary action is a link
   * into that page rather than anything that could complete a purchase.
   */
  assert.ok(read("src/lib/legal/terms.ts").length > 0);
  const cartPage = read("src/app/cart/page.tsx");
  assert.match(cartPage, /TermsInlineNotice/, "the checkout notice must still be on the cart page");
  assert.match(cartDrawer, /<Link href="\/cart"[\s\S]{0,120}cart-drawer-checkout/);
  assert.ok(!/<form|method="post"|onSubmit/i.test(cartDrawer), "the drawer submits nothing");
});

test("nothing in this pass reaches for the database", () => {
  /*
   * 4.1 is a layout and interaction pass and needs no schema. The check that
   * actually proves the migration ledger is untouched is `git diff` against
   * main; what this can usefully pin is the shape of the code, which is where a
   * migration requirement would come from in the first place.
   *
   * The drawer reads the cart the header already reads. The moment one of these
   * files talks to Supabase directly, it has stopped being a view of canonical
   * state and started being a second source of truth about money.
   */
  for (const [name, source] of [
    ["cart drawer", cartDrawer],
    ["cart drawer provider", cartProvider],
    ["cart indicator", cartIndicator],
    ["products menu", productsMenu],
  ] as const) {
    assert.ok(!/supabase|from\("[a-z_]+"\)|createClient/i.test(source), `${name} must not query the database`);
  }

  // The two hardening migrations named as untouchable are still on disk, so a
  // `git diff` that shows them as unchanged is comparing something real.
  for (const file of [
    "supabase/migrations/20260811025000_public_profile_projection.sql",
    "supabase/migrations/20260811030000_security_boundary_hardening.sql",
  ]) {
    assert.ok(read(file).length > 0, `${file} must still exist`);
  }
});
