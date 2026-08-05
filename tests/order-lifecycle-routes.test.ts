import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PERMISSIONS, PERMISSION_META } from "../src/lib/permissions.ts";

/**
 * The route contracts: who may act, what is recomputed server-side, and what
 * never reaches a customer.
 *
 * These are source assertions rather than live calls, because the interesting
 * properties are structural — "the amount is recomputed" and "the internal note
 * is not selected" are visible in the code and cannot be checked by poking one
 * happy path.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const customerCancel = read("src/app/api/orders/[id]/cancellation/route.ts");
const customerReturn = read("src/app/api/orders/[id]/returns/route.ts");
const customerLifecycle = read("src/app/api/orders/[id]/lifecycle/route.ts");
const staffCancel = read("src/app/api/staff/orders/[id]/cancellation/route.ts");
const staffRefund = read("src/app/api/staff/orders/[id]/refund/route.ts");
const staffReturn = read("src/app/api/staff/orders/[id]/returns/[returnId]/route.ts");
const staffLifecycle = read("src/app/api/staff/orders/[id]/lifecycle/route.ts");
const webhook = read("src/app/api/webhooks/stripe/route.ts");
const server = read("src/lib/commerce/orderLifecycleServer.ts");
const staffPanel = read("src/components/staff/OrderLifecyclePanel.tsx");
const customerPanel = read("src/components/commerce/OrderLifecycleActions.tsx");

const customerRoutes = { customerCancel, customerReturn, customerLifecycle };
const staffRoutes = { staffCancel, staffRefund, staffReturn, staffLifecycle };

// ---------------------------------------------------------------------------
// Ownership and authorization
// ---------------------------------------------------------------------------

test("every customer lifecycle route checks ownership against the order row", () => {
  for (const [name, source] of Object.entries(customerRoutes)) {
    assert.match(source, /getUserFromRequest/, `${name} does not authenticate`);
    assert.match(
      source,
      /customer_id !== user\.id/,
      `${name} does not compare the order's customer to the caller`
    );
  }
});

test("a customer who does not own the order gets 404, not 403", () => {
  // 403 confirms the order exists. 404 does not, so an id cannot be probed.
  for (const [name, source] of Object.entries(customerRoutes)) {
    assert.match(
      source,
      /customer_id !== user\.id[\s\S]{0,200}?status: 404/,
      `${name} leaks order existence to a non-owner`
    );
  }
});

test("no customer route can trigger a Stripe refund", () => {
  for (const [name, source] of Object.entries(customerRoutes)) {
    assert.equal(/issueOrderRefund|stripeClient|refunds\.create/.test(source), false, `${name} can move money`);
  }
});

test("staff lifecycle writes each require their own permission", () => {
  assert.match(staffCancel, /requirePermission\(req, "cancellations\.review"\)/);
  assert.match(staffReturn, /requirePermission\(req, "returns\.review"\)/);
  assert.match(staffRefund, /requirePermission\(req, "refunds\.issue"\)/);
});

test("issuing money needs refunds.issue even from inside a cancellation or return", () => {
  // `cancellations.review` alone approves; it does not pay out.
  assert.match(staffCancel, /permissions\.has\("refunds\.issue"\)/);
  assert.match(staffReturn, /permissions\.has\("refunds\.issue"\)/);
});

test("the new permissions exist and are documented", () => {
  for (const key of [
    "fulfillment.view",
    "fulfillment.manage",
    "cancellations.review",
    "returns.review",
    "refunds.issue",
    "inventory.view",
    "inventory.manage",
  ] as const) {
    assert.equal(PERMISSIONS.includes(key), true, `${key} is not registered`);
    assert.equal(Boolean(PERMISSION_META[key]?.label), true, `${key} has no label`);
    assert.equal(Boolean(PERMISSION_META[key]?.description), true, `${key} has no description`);
  }
});

test("refunds.issue is described as the one that moves money", () => {
  assert.match(PERMISSION_META["refunds.issue"].description, /money|funds/i);
});

// ---------------------------------------------------------------------------
// Never trust the client for money
// ---------------------------------------------------------------------------

test("a full refund amount is taken from the server's own figure", () => {
  assert.match(staffCancel, /refundCents = lifecycle\.refundableCents/);
});

test("a partial refund is checked against the server's refundable amount", () => {
  assert.match(staffCancel, /refundCents > lifecycle\.refundableCents/);
  assert.match(staffRefund, /Number\(amount\) > lifecycle\.refundableCents/);
  assert.match(staffReturn, /refundCents > lifecycle\.refundableCents/);
});

test("the refund route does not accept a payment id from the client", () => {
  // Which payment a refund draws from is decided under a row lock in
  // `begin_order_refund`; letting a client name one would let it aim at a
  // payment with capacity left after the order's own limit was reached.
  assert.equal(/body\?\.(order_)?payment_id/.test(staffRefund), false);
});

test("a client-supplied idempotency key can only collapse a duplicate, never widen an amount", () => {
  assert.match(staffRefund, /idempotency_key[\s\S]*slice\(0, 80\)/);
  assert.match(staffRefund, /manual-\$\{id\}-\$\{amount\}/);
});

test("return quantities are re-checked against server-computed eligible lines", () => {
  assert.match(customerReturn, /eligibility\.lines\.map/);
  assert.match(customerReturn, /entry\.quantity > line\.quantity/);
});

test("a customer cannot return an item the server did not offer", () => {
  assert.match(customerReturn, /if \(!line\) \{[\s\S]{0,300}status: 409/);
});

// ---------------------------------------------------------------------------
// Refund settlement
// ---------------------------------------------------------------------------

test("a refund is claimed in Postgres before Stripe is called", () => {
  const issue = server.slice(server.indexOf("export async function issueOrderRefund"));
  assert.equal(
    issue.indexOf("begin_order_refund") < issue.indexOf("refunds.create"),
    true,
    "Stripe is called before the local claim exists"
  );
});

test("a Stripe failure releases the claim rather than leaving it pending forever", () => {
  const issue = server.slice(server.indexOf("export async function issueOrderRefund"));
  assert.match(issue, /catch \(error\) \{[\s\S]*?stripeStatus = "failed"/);
  assert.match(issue, /settle_order_refund/);
});

test("Stripe's own idempotency key matches the local one", () => {
  assert.match(server, /idempotencyKey: leg\.idempotency_key/);
});

test("a refund Stripe reports as pending is not counted as settled", () => {
  const issue = server.slice(server.indexOf("export async function issueOrderRefund"));
  assert.match(issue, /else if \(stripeStatus === "pending"\) pendingCents \+= leg\.amount_cents/);
});

test("the webhook reconciles refunds, including ones created in the Stripe Dashboard", () => {
  assert.match(webhook, /event\.type\.startsWith\("refund\."\)/);
  assert.match(webhook, /charge\.refund\.updated/);
  assert.match(webhook, /reconcile_stripe_refund/);
});

test("a repeated refund webhook is dropped by the event table", () => {
  assert.match(webhook, /stripe_webhook_events[\s\S]{0,400}?23505[\s\S]{0,200}?duplicate: true/);
});

test("a failed reconciliation leaves the event unmarked so Stripe retries", () => {
  assert.match(webhook, /reconcileError[\s\S]{0,300}?delete\(\)\.eq\("stripe_event_id", event\.id\)/);
});

test("the webhook verifies its signature before anything else", () => {
  const post = webhook.slice(webhook.indexOf("export async function POST"));
  assert.equal(
    post.indexOf("constructEvent") < post.indexOf("routeServiceClient"),
    true,
    "a database write happens before the signature is checked"
  );
});

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

test("stock is committed at confirmed payment, not at checkout", () => {
  assert.match(webhook, /commit_order_inventory/);
  const checkout = read("src/app/api/cart/checkout/route.ts");
  assert.equal(/commit_order_inventory|adjust_product_inventory/.test(checkout), false);
});

test("a failed inventory commit never fails the payment", () => {
  assert.match(webhook, /if \(inventoryError\) \{[\s\S]{0,400}?logLifecycleFailure/);
  const block = webhook.slice(webhook.indexOf("commit_order_inventory"), webhook.indexOf("order_kind === \"direct_purchase\""));
  assert.equal(/return NextResponse/.test(block), false, "an inventory error aborts the payment handler");
});

test("cancellation restores inventory and releases the discount through guarded RPCs", () => {
  assert.match(server, /restore_order_inventory/);
  assert.match(server, /release_order_discount/);
});

// ---------------------------------------------------------------------------
// What a customer must never see
// ---------------------------------------------------------------------------

/**
 * The column lists inside `.select("…")`, with prose stripped.
 *
 * An earlier version of this test read the whole file and failed on the
 * *comment* explaining which columns are deliberately absent — which is the
 * wrong thing to check. What matters is the string PostgREST actually receives.
 */
const selectedColumns = (source: string) =>
  [...source.matchAll(/\.select\(\s*((?:"[^"]*"|\s|\+)+)\)/g)]
    .map((match) => match[1].replaceAll(/["\s+]/g, ""))
    .join(",");

test("the customer lifecycle endpoint never selects internal notes", () => {
  assert.equal(
    selectedColumns(customerLifecycle).includes("internal_note"),
    false,
    "internal_note is loaded into a customer payload"
  );
});

test("the customer lifecycle endpoint never selects Stripe identifiers or provider errors", () => {
  const columns = selectedColumns(customerLifecycle);
  assert.equal(columns.includes("stripe_refund_id"), false);
  assert.equal(columns.includes("failure_message"), false);
  assert.equal(columns.includes("failure_code"), false);
  // And the staff endpoint, which may see them, is a different file.
  assert.equal(selectedColumns(staffLifecycle).includes("*"), true);
});

test("the selected-column extractor actually sees the columns it is judging", () => {
  // Guards the guard: if the regex stopped matching, every leak test above
  // would pass vacuously.
  const columns = selectedColumns(customerLifecycle);
  assert.equal(columns.includes("decision_note"), true);
  assert.equal(columns.includes("return_instructions"), true);
});

test("the customer component renders no staff identity or provider internals", () => {
  for (const field of ["decided_by", "internal_note", "stripe_refund_id", "failure_message", "inspected_by"]) {
    assert.equal(customerPanel.includes(field), false, `${field} reaches the customer page`);
  }
});

test("the staff panel is the only surface that reads inventory movements", () => {
  assert.equal(customerPanel.includes("inventory_adjustments"), false);
  assert.equal(customerLifecycle.includes("inventory_adjustments"), false);
});

test("inventory history on the staff endpoint is gated on its own permission", () => {
  assert.match(staffLifecycle, /permissions\.has\("inventory\.view"\)[\s\S]{0,120}?inventory_adjustments/);
});

// ---------------------------------------------------------------------------
// Duplicate suppression and safe UI
// ---------------------------------------------------------------------------

test("a duplicate cancellation request is caught by the unique index, not a read-then-write", () => {
  assert.match(customerCancel, /code === "23505"/);
  assert.match(customerCancel, /alreadyRequested: true/);
});

test("withdrawing is conditional on the request still being pending", () => {
  assert.match(customerCancel, /\.eq\("status", "pending"\)/);
  assert.match(customerCancel, /already been decided/);
});

test("a staff decision is conditional on the request still being pending", () => {
  const approvals = staffCancel.match(/\.eq\("status", "pending"\)/g) ?? [];
  assert.equal(approvals.length >= 2, true, "approve and deny must both be conditional");
});

test("a return action is conditional on the return not having moved", () => {
  assert.match(staffReturn, /\.eq\("status", record\.status\)/);
  assert.match(staffReturn, /changed a moment ago/);
});

test("every return move is checked against the shared transition graph", () => {
  assert.match(staffReturn, /canTransitionReturn\(record\.status, to\)/);
});

test("a denial requires a customer-visible reason", () => {
  assert.match(staffCancel, /decisionNote\.length < 5[\s\S]{0,300}?status: 400/);
  assert.match(staffReturn, /decisionNote\.length < 5[\s\S]{0,300}?status: 400/);
});

test("consequential staff actions confirm with the amount and the consequence spelled out", () => {
  assert.match(staffPanel, /window\.confirm/);
  assert.match(staffPanel, /Remaining refundable after this/);
  assert.match(staffPanel, /cannot be taken back/);
});

test("the staff panel disables its controls while a request is in flight", () => {
  const disabled = staffPanel.match(/disabled=\{Boolean\(busy\)/g) ?? [];
  assert.equal(disabled.length >= 4, true, `expected several busy-guarded buttons, found ${disabled.length}`);
});

test("the customer panel confirms before submitting and never promises a refund", () => {
  assert.match(customerPanel, /window\.confirm/);
  assert.match(customerPanel, /not automatic|does not guarantee/i);
});

test("the customer panel disables submit while in flight", () => {
  const disabled = customerPanel.match(/disabled=\{Boolean\(busy\)/g) ?? [];
  assert.equal(disabled.length >= 3, true, `expected busy-guarded buttons, found ${disabled.length}`);
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("lifecycle failures log SQLSTATE but never the row body", () => {
  const logger = server.slice(server.indexOf("export function logLifecycleFailure"), server.indexOf("// ---", server.indexOf("export function logLifecycleFailure")));
  assert.match(logger, /code: pgError\?\.code/);
  assert.match(logger, /hint: pgError\?\.hint/);
  // `details` echoes conflicting row values back, and an order row carries
  // customer identifiers and money.
  assert.equal(/details/.test(logger), false, "the Postgres `details` field is being logged");
});

test("audit event types are staff-prefixed so logAuditEvent keeps them", () => {
  // `logAuditEvent` drops anything not admin/security/approvals/moderation/
  // staff-prefixed. A differently named type is silently discarded.
  const events = [...server.matchAll(/"(staff\.[a-z_.]+)"/g)].map((match) => match[1]);
  assert.equal(events.length >= 20, true, `expected the full audit list, found ${events.length}`);
  for (const event of events) assert.match(event, /^staff\./);
});

test("audit metadata records that a note existed rather than copying it", () => {
  assert.match(staffCancel, /had_internal_note: Boolean\(internalNote\)/);
  assert.equal(/metadata: \{[^}]*decision_note/.test(staffCancel), false);
});

// ---------------------------------------------------------------------------
// Email idempotency
// ---------------------------------------------------------------------------

test("every lifecycle email carries a stable event key", () => {
  const keys = [...[staffCancel, staffRefund, staffReturn, customerCancel, customerReturn, webhook]
    .join("\n")
    .matchAll(/eventKey: `([^`]+)`/g)].map((match) => match[1]);
  assert.equal(keys.length >= 8, true, `expected lifecycle emails to be keyed, found ${keys.length}`);
  for (const key of keys) {
    // A key built from a timestamp or a random value would send a fresh email
    // on every replay, which is exactly what the key exists to prevent.
    assert.equal(/Date\.now|Math\.random|new Date\(\)/.test(key), false, `unstable event key: ${key}`);
  }
});

test("the refund webhook keys its email on the Stripe refund id", () => {
  assert.match(webhook, /refund-webhook-\$\{stripeRefundId\}-\$\{status\}/);
});
