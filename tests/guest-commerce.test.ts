import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createGuestOrderToken,
  evaluateGuestAccess,
  guestAccessExpiry,
  guestDisplayName,
  guestTokenMatches,
  GUEST_ACCESS_WINDOW_DAYS,
  GUEST_ORDER_COOKIE,
  hashGuestOrderToken,
  normalizeGuestOrderToken,
  parseGuestContact,
} from "../src/lib/commerce/guestOrders.ts";
import { DEFAULT_COMMERCE_SETTINGS, parseCommerceSettings, publicCommerceSettings } from "../src/lib/commerce/commerceSettings.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const checkout = read("src/app/api/cart/checkout/route.ts");
const webhook = read("src/app/api/webhooks/stripe/route.ts");
const access = read("src/lib/commerce/guestOrderAccess.ts");
const guestPage = read("src/app/orders/guest/[id]/page.tsx");
const guestMessages = read("src/app/api/orders/guest/[id]/messages/route.ts");
const guestPay = read("src/app/api/orders/guest/[id]/checkout/route.ts");
const customRequest = read("src/app/api/orders/custom/route.ts");
const migration = read("supabase/migrations/20260806050000_guest_commerce.sql");
const turnstile = read("src/lib/security/turnstile.ts");
// `rateLimit.ts` is server-only, so its buckets are read as source rather than
// imported — the assertion is about what the file declares either way.
const rateLimitSource = read("src/lib/commerce/rateLimit.ts");

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

test("a guest token is high-entropy and opaque", () => {
  const token = createGuestOrderToken();
  // 32 random bytes, base64url. Length is asserted rather than assumed because
  // the cookie validator refuses anything outside 40–64 characters.
  assert.ok(token.length >= 40 && token.length <= 64, `unexpected length ${token.length}`);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(createGuestOrderToken(), createGuestOrderToken());
});

test("only the digest is ever stored, and it does not reveal the token", () => {
  const token = createGuestOrderToken();
  const hash = hashGuestOrderToken(token);
  assert.notEqual(hash, token);
  assert.ok(!hash.includes(token.slice(0, 12)));
  // Deterministic, so a lookup by digest works at all.
  assert.equal(hashGuestOrderToken(token), hash);
  assert.notEqual(hashGuestOrderToken(createGuestOrderToken()), hash);
});

test("a malformed or forged cookie is dropped rather than used as a key", () => {
  assert.equal(normalizeGuestOrderToken(undefined), null);
  assert.equal(normalizeGuestOrderToken(""), null);
  assert.equal(normalizeGuestOrderToken("short"), null);
  assert.equal(normalizeGuestOrderToken("../../etc/passwd"), null);
  assert.equal(normalizeGuestOrderToken("' or 1=1--"), null);
  assert.equal(normalizeGuestOrderToken("x".repeat(200)), null);
  const good = createGuestOrderToken();
  assert.equal(normalizeGuestOrderToken(` ${good} `), good);
});

test("token comparison refuses every non-match", () => {
  const token = createGuestOrderToken();
  assert.ok(guestTokenMatches(token, hashGuestOrderToken(token)));
  assert.ok(!guestTokenMatches(token, hashGuestOrderToken(createGuestOrderToken())));
  assert.ok(!guestTokenMatches(token, null));
  assert.ok(!guestTokenMatches(null, hashGuestOrderToken(token)));
  assert.ok(!guestTokenMatches(token, ""));
  // A different length must not throw — `timingSafeEqual` does on mismatched
  // buffers, so the length check has to come first.
  assert.doesNotThrow(() => guestTokenMatches(token, "short"));
  assert.ok(!guestTokenMatches(token, "short"));
});

// ---------------------------------------------------------------------------
// Expiry and revocation
// ---------------------------------------------------------------------------

const live = (token: string) => ({
  guest_token_hash: hashGuestOrderToken(token),
  guest_access_expires_at: guestAccessExpiry(),
});

test("a live token opens the order", () => {
  const token = createGuestOrderToken();
  assert.equal(evaluateGuestAccess(token, live(token)), "granted");
});

test("access expires on its own", () => {
  const token = createGuestOrderToken();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(
    evaluateGuestAccess(token, { guest_token_hash: hashGuestOrderToken(token), guest_access_expires_at: past }),
    "expired"
  );
  assert.equal(GUEST_ACCESS_WINDOW_DAYS, 90);
  const expiry = Date.parse(guestAccessExpiry(new Date("2026-01-01T00:00:00Z")));
  assert.equal(new Date(expiry).toISOString(), "2026-04-01T00:00:00.000Z");
});

test("a missing expiry fails closed rather than meaning 'forever'", () => {
  const token = createGuestOrderToken();
  assert.equal(
    evaluateGuestAccess(token, { guest_token_hash: hashGuestOrderToken(token), guest_access_expires_at: null }),
    "expired"
  );
  assert.equal(
    evaluateGuestAccess(token, { guest_token_hash: hashGuestOrderToken(token), guest_access_expires_at: "nonsense" }),
    "expired"
  );
});

test("clearing the hash revokes access, and cannot be undone by a flag", () => {
  const token = createGuestOrderToken();
  assert.equal(
    evaluateGuestAccess(token, { guest_token_hash: null, guest_access_expires_at: guestAccessExpiry() }),
    "revoked"
  );
});

test("one guest's token never opens another guest's order", () => {
  const mine = createGuestOrderToken();
  const theirs = createGuestOrderToken();
  assert.equal(evaluateGuestAccess(mine, live(theirs)), "mismatch");
  assert.equal(evaluateGuestAccess(null, live(mine)), "no_token");
  assert.equal(evaluateGuestAccess(mine, null), "mismatch");
});

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

test("a guest must give a usable address", () => {
  assert.equal(parseGuestContact({ email: "" }).ok, false);
  assert.equal(parseGuestContact({ email: "not-an-address" }).ok, false);
  assert.equal(parseGuestContact({ email: "a@b" }).ok, false, "a dotted domain is required");
  assert.equal(parseGuestContact({ email: `${"x".repeat(250)}@example.com` }).ok, false);
  const good = parseGuestContact({ email: "  Person@Example.COM ", name: "  Ada   Lovelace " });
  assert.ok(good.ok);
  if (good.ok) {
    assert.equal(good.contact.email, "person@example.com", "lower-cased for use as a key");
    assert.equal(good.contact.name, "Ada Lovelace");
  }
});

test("a header-injection attempt in the address is refused", () => {
  // This value reaches a mail send, and the subject line is the one
  // interpolated string that does not pass through escapeHtml.
  // A *trailing* tab or newline is trimmed and the address accepted, which is
  // right: the hazard is a control character the value carries into a header,
  // not whitespace a customer's clipboard added.
  for (const attempt of ["a@b.com\r\nBcc: victim@example.com", "a@b.com\nSubject: x", "a b@c.com", "a\tb@c.com"]) {
    assert.equal(parseGuestContact({ email: attempt }).ok, false, `${JSON.stringify(attempt)} must be refused`);
  }
});

test("a guest is greeted by name, or by the local part, never by nothing", () => {
  assert.equal(guestDisplayName({ email: "ada@example.com", name: "Ada" }), "Ada");
  assert.equal(guestDisplayName({ email: "ada@example.com", name: null }), "ada");
  assert.equal(guestDisplayName({ email: "" }), "Customer");
});

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

test("guest checkout and guest requests default on, and are switchable", () => {
  assert.equal(DEFAULT_COMMERCE_SETTINGS.guest.allowCheckout, true);
  assert.equal(DEFAULT_COMMERCE_SETTINGS.guest.allowRequests, true);
  const off = parseCommerceSettings({ guest: { allowCheckout: false, allowRequests: false } });
  assert.equal(off.guest.allowCheckout, false);
  assert.equal(off.guest.allowRequests, false);
  // Total: garbage degrades to the defaults rather than taking checkout offline.
  assert.equal(parseCommerceSettings({ guest: "yes" }).guest.allowCheckout, true);
  assert.equal(parseCommerceSettings(null).guest.allowRequests, true);
});

test("the public projection still carries no private address", () => {
  const settings = parseCommerceSettings({
    shipping: { originAddress: { line1: "17 Private Lane" } },
    returnAddress: { line1: "17 Private Lane" },
    guest: { allowCheckout: true },
  });
  const serialized = JSON.stringify(publicCommerceSettings(settings));
  assert.ok(!serialized.includes("Private Lane"), "the origin and return addresses must not be published");
  assert.match(serialized, /"guest":/, "but the guest switches are safe to publish");
});

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

test("a guest order is written with an identity, a digest and an expiry", () => {
  assert.match(checkout, /customer_id: user\?\.id \?\? null/);
  assert.match(checkout, /guest_email: guest\?\.email \?\? null/);
  assert.match(checkout, /guest_token_hash: guestOrderToken \? hashGuestOrderToken\(guestOrderToken\) : null/);
  assert.match(checkout, /guest_access_expires_at: guestOrderToken \? guestAccessExpiry\(\) : null/);
});

test("the credential is set httpOnly and never appears in a URL", () => {
  assert.match(checkout, new RegExp(`cookies\\.set\\(${GUEST_ORDER_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|GUEST_ORDER_COOKIE`));
  assert.match(checkout, /httpOnly: true/);
  assert.match(checkout, /sameSite: "lax"/);
  assert.match(checkout, /secure: process\.env\.NODE_ENV === "production"/);
  const source = code(checkout);
  assert.ok(!/success_url[\s\S]{0,200}guestOrderToken/.test(source), "no token in the success URL");
  assert.ok(!/console\.(log|error|warn)[\s\S]{0,120}guestOrderToken/.test(source), "no token in a log line");
});

test("guest checkout does not weaken the reservation or the pricing", () => {
  // Every guarantee the signed-in path had, on the same code path.
  assert.match(checkout, /reserveCartInventory\(\{/);
  assert.match(checkout, /releaseReservations\(\{ reason: "checkout_order_failed"/);
  assert.match(checkout, /releaseReservations\(\{ reason: "checkout_items_failed"/);
  assert.match(checkout, /releaseReservations\(\{ reason: "checkout_session_failed"/);
  assert.match(checkout, /linkCartReservationsToOrder\(/);
  assert.match(checkout, /expires_at: Math\.floor\(Date\.now\(\) \/ 1000\) \+ settings\.inventory\.reservationMinutes \* 60/);
  assert.match(checkout, /idempotencyKey: `direct-checkout-\$\{order\.id\}-\$\{totalCents\}`/);
  // The reservation is taken before the order exists, for both identities.
  assert.ok(checkout.indexOf("reserveCartInventory") < checkout.indexOf('.from("orders")'));
});

test("a guest with no cart cookie cannot check out", () => {
  assert.match(checkout, /if \(!guestToken\) \{[\s\S]{0,200}Your cart is empty/);
});

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

test("settlement binds a guest session to the order that recorded it", () => {
  assert.match(webhook, /const guestOrder = Boolean\(order && !order\.customer_id\)/);
  assert.match(webhook, /session\.metadata\?\.guest === "1" && order\.stripe_checkout_session_id === session\.id/);
  assert.match(webhook, /session\.metadata\?\.customer_id === order\.customer_id/);
  assert.match(webhook, /!identityMatches/);
});

test("a replayed webhook is still idempotent for a guest", () => {
  // Nothing about idempotency is identity-dependent: the event id is the key.
  assert.match(webhook, /from\("stripe_webhook_events"\)\.insert\(\{ stripe_event_id: event\.id/);
  assert.match(webhook, /error\?\.code === "23505"/);
  assert.match(webhook, /commitOrderReservations\(/);
});

test("an abandoned guest checkout releases its hold", () => {
  // Keyed purely on the session id, so it never consults an identity.
  assert.match(webhook, /reason: "checkout_session_expired",\s*checkoutSessionId: expiredSession\.id/);
});

test("a failed guest payment reaches the same branch an account's does", () => {
  assert.match(webhook, /const failedIsGuest = failedSession\.metadata\?\.guest === "1"/);
  assert.match(webhook, /if \(failedOrderId && \(failedCustomerId \|\| failedIsGuest\)\)/);
  assert.match(webhook, /releaseReservations\(\{ reason: "payment_failed", orderId: failedOrderId \}\)/);
});

test("a guest receipt goes to the address on the order, and no bell entry is invented", () => {
  assert.match(webhook, /recipientEmail = order\.customer_id \? authUser\?\.user\?\.email : order\.guest_email/);
  assert.match(webhook, /order\.customer_id\s*\?\s*notifyOrderUser\(\{/);
  assert.match(webhook, /: Promise\.resolve\(\)/);
  // And no admin lookup is attempted for a user that does not exist.
  assert.match(webhook, /order\.customer_id\s*\n?\s*\?\s*\(await routeServiceClient\.auth\.admin\.getUserById/);
});

// ---------------------------------------------------------------------------
// Guest order access
// ---------------------------------------------------------------------------

test("the guest view selects named columns and none of them are internal", () => {
  const columns = access.match(/const GUEST_ORDER_COLUMNS =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
  assert.ok(columns.length > 0, "the column list must be explicit");
  for (const forbidden of ["customer_id", "fulfillment_notes", "staff_notes", "stripe_checkout_session_id", "internal"]) {
    assert.ok(!columns.split(",").includes(forbidden), `${forbidden} must not reach a guest`);
  }
  // The one note written *for* a customer is present; the internal one is not.
  assert.ok(columns.split(",").includes("customer_shipment_note"));
  assert.doesNotMatch(code(access), /select\("\*"\)/, "a wildcard select would leak the next column added");
});

test("the credential and the expiry never leave the resolver", () => {
  assert.match(access, /const \{ guest_token_hash: _hash, guest_access_expires_at: _expires, \.\.\.order \} = row/);
});

test("an internal staff note never reaches a guest's message thread", () => {
  const source = code(access);
  assert.match(source, /\.eq\("is_internal", false\)/);
  // Applied inside the query rather than filtered afterwards, so a row that
  // should not be here is never loaded at all.
  const messageQuery = source.slice(source.indexOf('.from("order_messages")'));
  assert.ok(messageQuery.indexOf('.eq("is_internal", false)') >= 0);
  assert.ok(
    messageQuery.indexOf('.eq("is_internal", false)') < messageQuery.indexOf(".limit(200)"),
    "the filter must be part of the query that loads the rows"
  );
  assert.doesNotMatch(source, /\.filter\([^)]*is_internal/, "not filtered in JavaScript after loading");
  // A staff sender id is dropped rather than passed on: it names a staff
  // account, which is not this customer's business.
  assert.match(source, /fromStaff: Boolean\(row\.sender_id\)/);
});

test("a guest write requires the order to have no account owner", () => {
  assert.match(access, /if \(!row \|\| row\.customer_id\) return \{ ok: false, reason: "mismatch" \}/);
  assert.match(access, /const verdict = evaluateGuestAccess\(token, row\)/);
});

test("there is no lookup by order number and email anywhere", () => {
  for (const [name, source] of [["access", access], ["page", guestPage], ["messages", guestMessages], ["pay", guestPay]] as const) {
    // The select list legitimately names both columns; what must not exist is
    // a *query* that filters on an address the caller supplied.
    const withoutColumnLists = code(source).replace(/"[a-z_,]{40,}"/g, '"COLUMNS"');
    assert.doesNotMatch(withoutColumnLists, /\.eq\("guest_email"|\.ilike\("guest_email"|lower\(guest_email\)/, `${name} must not look an order up by address`);
    assert.doesNotMatch(withoutColumnLists, /body\.(email|order_number)|params\.(email|order_number)/, `${name} must not accept an address or order number as a credential`);
  }
  assert.match(access, /Because it is a guessing oracle/, "and the reason is written down");
});

test("the guest order page is never indexed and never followed", () => {
  assert.match(guestPage, /robots: \{ index: false, follow: false, nocache: true \}/);
});

test("every denial reads the same, except an expiry that already matched", () => {
  assert.match(guestPage, /const expired = result\.reason === "expired"/);
  // A refused query is its own state and is not rendered as "not found".
  assert.match(guestPage, /const unavailable = result\.reason === "unavailable"/);
  assert.match(access, /if \(error\) return \{ ok: false, reason: "unavailable" \}/);
});

// ---------------------------------------------------------------------------
// Guest writes
// ---------------------------------------------------------------------------

test("a guest reply cannot be internal and cannot be attributed to an account", () => {
  assert.match(guestMessages, /sender_id: null/);
  assert.match(guestMessages, /is_internal: false/);
  const source = code(guestMessages);
  assert.doesNotMatch(source, /body\?\.internal/, "internal must not be readable from the payload");
  assert.doesNotMatch(source, /body\?\.sender/, "the sender must not be readable from the payload");
});

test("guest writes authorize, rate limit, and answer every denial identically", () => {
  for (const [name, source] of [["messages", guestMessages], ["pay", guestPay]] as const) {
    assert.match(source, /authorizeGuestOrderWrite\(token, id\)/, `${name} must authorize`);
    assert.match(source, /That order is not available on this device/, `${name} must not distinguish denials`);
    assert.match(source, /consumeRateLimit\(RATE_LIMITS\./, `${name} must rate limit`);
  }
});

test("guest payment recomputes the amount and reads nothing from the body", () => {
  assert.match(guestPay, /checkoutAmountCents\(order\)/);
  assert.match(guestPay, /\.is\("customer_id", null\)/);
  const source = code(guestPay);
  assert.doesNotMatch(source, /req\.json\(\)/, "the request body is not read at all");
  assert.match(guestPay, /idempotencyKey: `guest-checkout-\$\{order\.id\}-\$\{amountDue\}-\$\{collectedBeforeCheckout\}`/);
  // The same three gates the account route applies.
  assert.match(guestPay, /\["accepted", "awaiting_payment", "in_progress"\]\.includes\(order\.status\)/);
  assert.match(guestPay, /quote_expires_at/);
  assert.match(guestPay, /amountDue < 50/);
});

test("the account payment route is untouched by the guest path", () => {
  const accountPay = read("src/app/api/orders/[id]/checkout/route.ts");
  assert.match(accountPay, /\.eq\("customer_id", user\.id\)/, "its ownership check must not have been loosened");
  assert.doesNotMatch(accountPay, /guest/i, "and it must not have grown a guest branch");
});

// ---------------------------------------------------------------------------
// Guest custom requests
// ---------------------------------------------------------------------------

test("a guest request is gated by a setting, a rate limit and Turnstile", () => {
  assert.match(customRequest, /if \(!settings\.guest\.allowRequests\)/);
  assert.match(customRequest, /consumeRateLimit\(RATE_LIMITS\.guestRequest/);
  assert.match(customRequest, /verifyTurnstile\(body\.turnstile_token/);
  assert.ok(
    customRequest.indexOf("verifyTurnstile") < customRequest.indexOf('.from("orders")'),
    "the checks must run before a row is written"
  );
});

test("guest rate limits exist and are tighter than the signed-in equivalents", () => {
  const rule = (name: string) => {
    const match = new RegExp(`${name}[^\\n]*limit: (\\d+), windowSeconds: (\\d+)`).exec(rateLimitSource);
    assert.ok(match, `${name} must be declared`);
    return { limit: Number(match[1]), windowSeconds: Number(match[2]) };
  };
  const guestRequest = rule("guestRequest");
  assert.equal(guestRequest.limit, 5);
  assert.equal(guestRequest.windowSeconds, 3600);
  assert.ok(guestRequest.limit < rule("orderCancel").limit, "tighter than the signed-in lifecycle limit");
  assert.ok(rule("guestMessage").limit <= 20);
  assert.ok(rule("guestCheckout").limit <= 20);
});

test("a guest cannot attach a file, and is told rather than having it dropped", () => {
  assert.match(customRequest, /Files can be attached once you have an account/);
  // The account path's prefix check survives unchanged.
  assert.match(customRequest, /!file\.path\.startsWith\(`\$\{user\.id\}\/`\)/);
});

test("a referenced product is resolved from the database, never trusted", () => {
  assert.match(customRequest, /\.from\("products"\)[\s\S]{0,200}\.eq\("slug", productSlug\)/);
  assert.match(customRequest, /\.eq\("is_published", true\)/);
  assert.match(customRequest, /\.is\("archived_at", null\)/);
  assert.match(customRequest, /display_value: sourceProduct\.name/);
});

test("free-form option context is bounded on both key and value", () => {
  assert.match(customRequest, /\.slice\(0, 30\)/);
  assert.match(customRequest, /const label = clean\(key, 80\)/);
  assert.match(customRequest, /const text = clean\(value, 200\)/);
});

test("staff are alerted and the customer is acknowledged, both deduplicated", () => {
  assert.match(customRequest, /raiseOperationalAlert\(\{[\s\S]{0,200}kind: "order\.new_request"/);
  assert.match(customRequest, /eventKey: `custom-request-customer-\$\{order\.id\}`/);
  assert.match(customRequest, /eventKey: `custom-request-staff-\$\{order\.id\}`/);
  assert.match(customRequest, /templateKey: "request_received"/);
});

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

test("Turnstile is a no-op unconfigured and fails closed once configured", () => {
  assert.match(turnstile, /if \(!secret\) return \{ ok: true, configured: false \}/);
  assert.match(turnstile, /return \{ ok: false, configured: true, reason: "unavailable" \}/);
  // Explicitly not "allow on network error".
  const source = code(turnstile);
  assert.doesNotMatch(source, /catch \{\s*return \{ ok: true/);
  assert.match(turnstile, /AbortSignal\.timeout\(6000\)/);
  assert.doesNotMatch(source, /console\.[a-z]+\([^)]*token/, "the token must never be logged");
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("the guest migration widens and adds, and never drops or rewrites", () => {
  const sql = migration.toLowerCase();
  for (const forbidden of ["drop table", "drop column", "drop constraint", "truncate", "delete from", "update public.orders set"]) {
    assert.ok(!sql.includes(forbidden), `the migration must not ${forbidden}`);
  }
  assert.match(sql, /alter column customer_id drop not null/);
  assert.match(sql, /alter column sender_id drop not null/);
  // Both widenings are guarded on the data first.
  assert.match(sql, /orders where customer_id is null[\s\S]{0,200}raise exception/);
  assert.match(sql, /order_messages where sender_id is null[\s\S]{0,200}raise exception/);
});

test("an order always has an owner, and a message always has a source", () => {
  assert.match(migration, /orders_owner_present[\s\S]{0,120}customer_id is not null or guest_email is not null/);
});

test("the guest columns are bounded and indexed where they are looked up", () => {
  assert.match(migration, /orders_guest_email_shape/);
  assert.match(migration, /orders_guest_name_length/);
  assert.match(migration, /create index if not exists orders_guest_token_hash_idx[\s\S]{0,200}where guest_token_hash is not null/);
});

test("the migration issues no grants, because columns inherit the table's ACL", () => {
  // The pass-5a failure mode is unreachable for a column addition, and the
  // migration says so rather than leaving the next reader to wonder.
  assert.doesNotMatch(migration, /^\s*grant /im);
  assert.match(migration, /No grants\. These are columns on a table that already has its ACL/);
});
