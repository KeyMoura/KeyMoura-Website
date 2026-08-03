import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const cartService = read("src/lib/commerce/cartService.ts");
const cartSession = read("src/lib/commerce/cartSession.ts");
const cartRoute = read("src/app/api/cart/route.ts");

test("adding to the cart re-prices the product server-side before it is stored", () => {
  const addItem = cartService.slice(cartService.indexOf("export async function addCartItem"));
  // The add path must run the same rejection rules as display and checkout,
  // or a request-only product could be pushed into a cart by a raw payload.
  assert.match(addItem, /loadPricedProducts\(\[productId\]\)/);
  assert.match(addItem, /priceLine\(product, \{ productId, quantity, selectedOptions \}\)/);
  assert.match(addItem, /if \(isRejected\(priced\)\) return \{ error: priced\.blocker\.message/);
});

test("a stored cart line keeps the server-resolved options, not the raw payload", () => {
  const addItem = cartService.slice(cartService.indexOf("export async function addCartItem"));
  // priced.selectedOptions contains only options that matched a live, active
  // value; storing the raw input would let an unknown option key survive.
  assert.match(addItem, /selected_options: priced\.selectedOptions/);
  assert.doesNotMatch(addItem, /selected_options: selectedOptions[,\s]/);
});

test("cart mutations are scoped to the caller's own cart", () => {
  for (const fn of ["updateCartItemQuantity", "removeCartItem"]) {
    const body = cartService.slice(cartService.indexOf(`export async function ${fn}`));
    const scoped = body.slice(0, body.indexOf("\n}"));
    assert.match(scoped, /\.eq\("cart_id", cart\.id\)/, `${fn} must scope by the resolved cart`);
  }
});

test("quantity updates report a foreign or stale item id rather than silently passing", () => {
  const body = cartService.slice(cartService.indexOf("export async function updateCartItemQuantity"));
  assert.match(body.slice(0, body.indexOf("\n}")), /if \(!data\?\.length\) return \{ error:/);
});

test("the guest cart cookie is httpOnly and not sent cross-site", () => {
  const attach = cartSession.slice(cartSession.indexOf("export function attachGuestCookie"));
  assert.match(attach, /httpOnly: true/);
  assert.match(attach, /sameSite: "lax"/);
  assert.match(attach, /secure: process\.env\.NODE_ENV === "production"/);
});

test("a malformed guest cookie is ignored instead of used as a lookup key", () => {
  assert.match(cartSession, /\/\^\[A-Za-z0-9_-\]\{40,64\}\$\/\.test\(raw\)/);
});

test("a signed-in customer's cart always wins over a stale guest cookie", () => {
  const resolve = cartSession.slice(cartSession.indexOf("export async function resolveOwner"));
  const body = resolve.slice(0, resolve.indexOf("\n}"));
  // The authenticated branch returns a customer-owned cart and hands the guest
  // token to the merge path rather than using it as the owner.
  assert.match(body, /owner: \{ customerId: user\.id \}/);
  assert.match(body, /pendingGuestMerge: guestToken/);
});

test("a merged guest cart clears its cookie so no live handle survives", () => {
  assert.match(cartRoute, /merged \? clearGuestCookie\(res\) : attachGuestCookie\(res, resolved\)/);
});

test("reading the cart never mints a guest cookie", () => {
  const get = cartRoute.slice(cartRoute.indexOf("export async function GET"));
  const body = get.slice(0, get.indexOf("\n}"));
  assert.match(body, /resolveOwner\(req\)/);
  assert.doesNotMatch(body, /resolveOwnerForWrite/, "a plain read must not hand a cookie to a passing visitor");
});

test("every cart response is the whole re-resolved cart, never a client total", () => {
  assert.match(cartRoute, /serializeCart\(cart\)/);
  // No handler accepts a price, subtotal, or total from the browser.
  for (const forbidden of ["unitPriceCents", "subtotalCents", "totalCents", "priceCents"]) {
    assert.doesNotMatch(
      cartRoute,
      new RegExp(`body\.${forbidden}`),
      `the cart API must never read ${forbidden} from the request body`
    );
  }
});

test("the cart is bounded so it cannot be grown without limit", () => {
  assert.match(cartService, /export const MAX_CART_LINES = \d+/);
  assert.match(cartService, /existing\.length >= MAX_CART_LINES/);
});

test("clearing the cart also drops the stored discount code", () => {
  const body = cartService.slice(cartService.indexOf("export async function clearCart"));
  assert.match(body.slice(0, body.indexOf("\n}")), /discount_code: null/);
});

test("the cart indicator is reachable on mobile as well as desktop", () => {
  const header = readFileSync(new URL("../src/components/SiteHeader.tsx", import.meta.url), "utf8");
  // The desktop utilities row is hidden below lg, so a single mount would
  // leave a phone user with a full cart and no way back to it.
  const mounts = header.match(/<CartIndicator \/>/g) ?? [];
  assert.equal(mounts.length, 2, "CartIndicator must be mounted in both the desktop and mobile bars");
});

test("the cart drawer is a dialog that returns focus and closes on Escape", () => {
  const indicator = readFileSync(new URL("../src/components/commerce/CartIndicator.tsx", import.meta.url), "utf8");
  assert.match(indicator, /role="dialog"/);
  assert.match(indicator, /aria-expanded=\{open\}/);
  assert.match(indicator, /event\.key === "Escape"/);
  assert.match(indicator, /buttonRef\.current\?\.focus\(\)/);
});
