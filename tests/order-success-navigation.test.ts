import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { customerOrderPath } from "../src/lib/commerce/orderUrls.ts";

/**
 * Where a customer lands after creating a request.
 *
 * The rule these lock in is narrow and worth stating: **the server decides
 * where a new order is readable from, and the client follows it.** Ownership is
 * the server's fact — it is the side that knows whether the row got a
 * `customer_id` or a guest token — so a client that rebuilds the path is
 * computing the same answer a second time with less information, and the copy
 * the customer actually follows is the one that can be wrong.
 *
 * `/orders/<id>` reads through RLS as the signed-in customer; a guest following
 * it gets a permission error for their own request. That is the failure these
 * guard against.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Comments stripped, so a rule described in prose cannot satisfy an assertion. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const customRoute = read("src/app/api/orders/custom/route.ts");
const requestForm = read("src/components/product/ProductRequestForm.tsx");
const newRequestPage = read("src/components/orders/CustomRequestWizard.tsx");
const confirmedPage = read("src/app/orders/[id]/confirmed/page.tsx");
const accountOrderRoute = read("src/app/api/orders/route.ts");

// ---------------------------------------------------------------------------
// The server's answer
// ---------------------------------------------------------------------------

test("the custom request route returns a canonical href chosen by ownership", () => {
  assert.match(
    customRoute,
    /href: guestToken \? `\/orders\/guest\/\$\{order\.id\}` : `\/orders\/\$\{order\.id\}\/confirmed`/,
    "the route must decide the destination from whether a guest token was minted"
  );
});

test("the canonical helper still separates the two homes", () => {
  assert.equal(customerOrderPath("abc", "cust-1"), "/orders/abc");
  assert.equal(customerOrderPath("abc", null), "/orders/guest/abc");
  assert.equal(customerOrderPath("abc", undefined), "/orders/guest/abc");
});

// ---------------------------------------------------------------------------
// The clients follow it
// ---------------------------------------------------------------------------

test("a guest product request follows the server href and never the account path", () => {
  assert.match(
    requestForm,
    /router\.push\(guestData\.href \?\? `\/orders\/guest\/\$\{guestData\.id\}`\)/,
    "the guest branch must prefer the server's href"
  );
  // Even the fallback is guest-safe, so a response without an href cannot land
  // a guest on a page that reads through RLS.
  const guestBranch = requestForm.slice(
    requestForm.indexOf("if (!auth.user)"),
    requestForm.indexOf("const requestToken")
  );
  assert.ok(guestBranch.length > 0, "the guest branch must exist");
  assert.doesNotMatch(
    code(guestBranch),
    /router\.push\(`\/orders\/\$\{[^}]+\}(\/confirmed)?`\)/,
    "the guest branch must never push a bare /orders/<id> path"
  );
  assert.match(guestBranch, /\/api\/orders\/custom/, "the guest branch posts to the guest-capable route");
});

test("the account product request path is account-only by construction", () => {
  // The branch below the guest early-return runs only for a signed-in user, and
  // the route it posts to refuses anyone else — so `/orders/<id>/confirmed` is
  // the correct destination there rather than an accident.
  assert.match(requestForm, /if \(!auth\.user\) \{/);
  const accountBranch = requestForm.slice(requestForm.indexOf("const requestToken"));
  assert.match(accountBranch, /fetch\("\/api\/orders"/, "the account branch posts to the account route");
  assert.match(
    accountOrderRoute,
    /const user = await requireUser\(req\);\s*if \(!user\) return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 401 \}\)/,
    "the account route must reject an unauthenticated caller"
  );
});

test("the custom request page uses the server href rather than rebuilding it", () => {
  // The assertion is that the client stops deriving the answer at all — the
  // defect class is a client that recomputes ownership, not one that recomputes
  // it wrongly right now.
  //
  // It stopped being hypothetical in Custom Project Request 3.0. This page is
  // no longer signed-in only: `/api/orders/custom` had always accepted guest
  // requests, and the page was the only thing refusing them — at the *end* of a
  // long form, on submit. Now a guest can send one, and the server's `href` is
  // the difference between landing on their order and landing on a page that
  // refuses them.
  assert.match(newRequestPage, /result\.href \?\? `\/orders\/\$\{result\.id\}\/confirmed`/);
  assert.match(
    newRequestPage,
    /href\?: string;/,
    "href must be declared, not discarded"
  );
  assert.match(
    newRequestPage,
    /if \(!signedIn && !guestRequestsAllowed\) \{\s*\n\s*router\.push\(`\/auth\/login\?next=/,
    "sign-in is required only when the shop has guest requests switched off"
  );
});

// ---------------------------------------------------------------------------
// The confirmation CTA
// ---------------------------------------------------------------------------

test("the confirmation CTA resolves ownership instead of reconstructing a path", () => {
  assert.match(confirmedPage, /customerOrderPath\(id, \(data as \{ customer_id: string \| null \}\)\.customer_id\)/);
  assert.match(confirmedPage, /\.select\("customer_id"\)/);
  // No bare template-literal link left in the markup.
  assert.doesNotMatch(code(confirmedPage), /href=\{`\/orders\/\$\{id\}`\}/);
  assert.match(confirmedPage, /<Link href=\{href\}/);
});

test("the confirmation page never renders order content, only a destination", () => {
  // It resolves one column and shows none of it, so the lookup cannot become a
  // way to read an order.
  const source = code(confirmedPage);
  assert.doesNotMatch(source, /order_number|guest_email|product_name|agreed_price_cents|amount_paid/);
  assert.match(source, /Request received/);
});

test("a failed or malformed lookup keeps the historical destination", () => {
  // Failing to the account path matches every route that currently leads here;
  // failing to the guest path would send an account customer to a verification
  // form for an order that can never issue one.
  assert.match(confirmedPage, /let href = `\/orders\/\$\{id\}`/);
  assert.match(confirmedPage, /if \(!error && data\)/);
  assert.match(confirmedPage, /uuid\.test\(id\)/, "a malformed id must not reach the database");
});

// ---------------------------------------------------------------------------
// No regression to the routing that already worked
// ---------------------------------------------------------------------------

test("checkout still sends guests and accounts to their own pages", () => {
  const checkout = read("src/app/api/cart/checkout/route.ts");
  assert.match(
    checkout,
    /success_url: guest\s*\?\s*`\$\{siteUrl\}\/orders\/guest\/\$\{order\.id\}\?payment=success`\s*:\s*`\$\{siteUrl\}\/orders\/\$\{order\.id\}\?payment=success`/,
    "the Stripe return must stay branched on identity"
  );
});

test("guest verification routing is untouched by this fix", () => {
  const guestPage = read("src/app/orders/guest/[id]/page.tsx");
  assert.match(guestPage, /if \(result\.reason !== "unavailable"\) return <GuestOrderVerification orderId=\{id\} \/>/);
  // The confirmation CTA can point a guest at the guest page; that page still
  // demands a session or a code, so the link is not an access path.
  assert.match(guestPage, /resolveGuestOrder\(id\)/);
});

test("no customer-facing navigation puts a credential in a URL", () => {
  for (const [name, source] of [
    ["request form", requestForm],
    ["new request page", newRequestPage],
    ["confirmed page", confirmedPage],
    ["custom route", customRoute],
  ] as const) {
    assert.doesNotMatch(code(source), /[?&](token|code)=/, `${name} must not put a credential in a URL`);
  }
});
