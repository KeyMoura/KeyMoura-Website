import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const checkout = read("src/app/api/cart/checkout/route.ts");
const webhook = read("src/app/api/webhooks/stripe/route.ts");
const addToCart = read("src/components/commerce/AddToCartButton.tsx");
const productPage = read("src/app/catalog/[slug]/page.tsx");

test("checkout re-resolves the cart from live products before charging", () => {
  const orderInsert = checkout.indexOf('.from("orders")');
  const revalidate = checkout.indexOf("resolveCart({ customerId: user.id })");
  assert.ok(revalidate > 0, "checkout must resolve the cart server-side");
  assert.ok(revalidate < orderInsert, "revalidation must happen before the order is written");
});

test("the charged amount comes from the resolved cart, never the request body", () => {
  assert.match(checkout, /agreed_price_cents: totalCents/);
  assert.match(checkout, /unit_amount: totalCents/);
  assert.match(checkout, /const totalCents = cart\.totals\.totalCents/);
  // No amount, price, or total is ever read off the request.
  for (const field of ["amount", "total", "price", "discountCents"]) {
    assert.doesNotMatch(checkout, new RegExp(`body\.${field}`), `checkout must not read ${field} from the client`);
  }
});

test("checkout refuses a cart holding anything unavailable", () => {
  assert.match(checkout, /if \(cart\.priced\.rejected\.length\)/);
  assert.match(checkout, /status: 409/);
});

test("checkout requires a signed-in customer and says so explicitly", () => {
  const guard = checkout.slice(checkout.indexOf("const user = await getUserFromRequest"));
  assert.match(guard.slice(0, 400), /requiresSignIn: true/);
  assert.match(guard.slice(0, 400), /status: 401/);
});

test("a guest cart is merged into the account before checkout prices it", () => {
  const merge = checkout.indexOf("mergeGuestCart(guestToken, user.id)");
  const resolve = checkout.indexOf("resolveCart({ customerId: user.id })");
  assert.ok(merge > 0 && merge < resolve, "the guest cart must be folded in before the cart is priced");
});

test("a direct order carries the same webhook metadata the quote flow uses", () => {
  // The existing webhook matches on order_id and customer_id before settling
  // money; a direct order that omitted either would never be paid out.
  assert.match(checkout, /metadata: \{ order_id: order\.id, customer_id: user\.id/);
  assert.match(checkout, /payment_intent_data: \{ metadata: \{ order_id: order\.id, customer_id: user\.id \} \}/);
});

test("order lines are snapshotted so a later product edit cannot rewrite them", () => {
  const items = checkout.slice(checkout.indexOf('.from("order_items")'));
  for (const column of ["product_name", "unit_price_cents", "line_subtotal_cents", "selected_options"]) {
    assert.ok(items.includes(column), `order_items must snapshot ${column}`);
  }
});

test("a failed checkout leaves no half-written order behind", () => {
  assert.match(checkout, /await routeServiceClient\.from\("orders"\)\.delete\(\)\.eq\("id", order\.id\)/);
});

test("the cart is emptied only after the webhook confirms payment", () => {
  // Not at session creation (the customer may abandon Stripe) and not on the
  // success redirect (that is a URL, not a payment).
  const branch = webhook.slice(webhook.indexOf('order.order_kind === "direct_purchase"'));
  assert.match(branch, /from\("cart_items"\)\.delete\(\)/);
  assert.match(branch, /status: "converted"/);
  assert.doesNotMatch(checkout, /cart_items"\)\.delete/, "checkout must not empty the cart before payment");
});

test("discount usage is recorded through the locking RPC, not a raw insert", () => {
  const branch = webhook.slice(webhook.indexOf('order.order_kind === "direct_purchase"'));
  assert.match(branch, /rpc\("redeem_discount_code"/);
  assert.doesNotMatch(branch, /from\("discount_redemptions"\)\.insert/);
});

test("the webhook still dedupes events before any money moves", () => {
  const insertAt = webhook.indexOf('from("stripe_webhook_events")');
  const rpcAt = webhook.indexOf('rpc("record_stripe_order_payment"');
  assert.ok(insertAt > 0 && insertAt < rpcAt, "the idempotency row must be claimed before settlement");
  assert.match(webhook, /error\?\.code === "23505"/);
});

test("the buy actions follow the purchase mode", () => {
  assert.match(addToCart, /allowsDirectPurchase\(purchaseMode\) && startingPriceCents != null && available/);
  assert.match(addToCart, /const canRequest = allowsRequest\(purchaseMode\)/);
  // direct_or_request shows both paths.
  assert.match(addToCart, /Request a custom version/);
});

test("a product that cannot be requested never renders the request wizard", () => {
  assert.match(productPage, /!allowsRequest\(purchaseMode\)/);
});
