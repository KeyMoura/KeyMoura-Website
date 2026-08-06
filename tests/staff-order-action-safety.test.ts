import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resultFromResponse } from "../src/lib/staff/actionResult.ts";

/**
 * Pass 11: every consequential staff order action is guarded, confirmed, and
 * survives being clicked twice.
 *
 * Two kinds of test here, and the split is deliberate.
 *
 * `resultFromResponse` is exercised for real, because it is where the decision
 * "may this be retried, and may this message be shown" actually lives — and both
 * halves of that are the sort of thing a refactor quietly gets wrong.
 *
 * The route and component guards are source assertions. That is not laziness:
 * the property worth pinning is *structural*. "The update re-asserts the status
 * it read" cannot be demonstrated by calling a happy path, and a live test would
 * need two racing connections against a real Postgres to say anything the source
 * does not already say plainly.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const orderRoute = read("src/app/api/staff/orders/[id]/route.ts");
const messageRoute = read("src/app/api/orders/[id]/messages/route.ts");
const returnRoute = read("src/app/api/staff/orders/[id]/returns/[returnId]/route.ts");
const cancellationRoute = read("src/app/api/staff/orders/[id]/cancellation/route.ts");
const refundRoute = read("src/app/api/staff/orders/[id]/refund/route.ts");
const fulfillmentRoute = read("src/app/api/staff/orders/[id]/fulfillment/route.ts");
const productionStatusRoute = read("src/app/api/staff/production/jobs/[id]/status/route.ts");

const dialog = read("src/components/staff/ConsequentialAction.tsx");
const orderPage = read("src/app/staff/orders/[id]/page.tsx");
const lifecyclePanel = read("src/components/staff/OrderLifecyclePanel.tsx");
const fulfillmentPanel = read("src/components/staff/OrderFulfillmentPanel.tsx");
const messageMigration = read("supabase/migrations/20260806020000_order_message_client_token.sql");

// ---------------------------------------------------------------------------
// Response mapping — what may be retried, and what may be shown
// ---------------------------------------------------------------------------

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a 409 becomes a conflict, never a plain error", async () => {
  const result = await resultFromResponse(
    json(409, { error: "Somebody changed this order a moment ago.", currentStatus: "in_progress" })
  );
  assert.equal(result.ok, false);
  assert.ok("conflict" in result, "409 must produce a conflict the caller can refuse to retry");
  if (!("conflict" in result)) return;
  assert.match(result.conflict.message, /changed this order/);
  // Underscores are a database detail. Staff read "in progress".
  assert.equal(result.conflict.currentState, "in progress");
});

test("a conflict without a named status still reads as a conflict", async () => {
  const result = await resultFromResponse(json(409, {}));
  assert.ok("conflict" in result);
  if (!("conflict" in result)) return;
  assert.match(result.conflict.message, /Somebody else acted/);
  assert.equal(result.conflict.currentState, null);
});

test("the fulfillment route's `status` key is read as the current state too", async () => {
  // That route answers `{ error, status }` rather than `{ error, currentStatus }`.
  // Both shapes must land in the same place, or a stale shipment shows a
  // conflict with no state in it.
  const result = await resultFromResponse(json(409, { error: "It moved on.", status: "shipped" }));
  assert.ok("conflict" in result);
  if (!("conflict" in result)) return;
  assert.equal(result.conflict.currentState, "shipped");
});

test("a 500 never shows the server's own words", async () => {
  const leak = 'duplicate key value violates unique constraint "orders_pkey" DETAIL: Key (id)=(abc) exists.';
  const result = await resultFromResponse(json(500, { error: leak }));
  assert.equal(result.ok, false);
  assert.ok(!("conflict" in result));
  if ("conflict" in result || result.ok) return;
  assert.doesNotMatch(result.error, /constraint|DETAIL|orders_pkey/, "a 500 must not surface schema detail");
  assert.match(result.error, /Nothing was changed/);
});

test("a 403 is explained as permission rather than as a failure", async () => {
  const result = await resultFromResponse(json(403, {}));
  if (result.ok || "conflict" in result) return assert.fail("403 must be a plain error");
  assert.match(result.error, /permission/i);
});

test("a 400 keeps the route's message, which is written for the operator", async () => {
  const result = await resultFromResponse(json(400, { error: "Add a carrier and tracking number." }));
  if (result.ok || "conflict" in result) return assert.fail("400 must be a plain error");
  assert.equal(result.error, "Add a carrier and tracking number.");
});

test("a body that is not JSON does not throw", async () => {
  const result = await resultFromResponse(new Response("<html>gateway timeout</html>", { status: 504 }));
  assert.equal(result.ok, false);
  if (result.ok || "conflict" in result) return;
  assert.doesNotMatch(result.error, /html/);
});

test("a 200 is a success", async () => {
  assert.deepEqual(await resultFromResponse(json(200, { ok: true })), { ok: true });
});

// ---------------------------------------------------------------------------
// Stale-page conflict protection
// ---------------------------------------------------------------------------

test("the order route compares the state the page rendered from", () => {
  assert.match(orderRoute, /expected_status/, "the route must accept the client's expected status");
  assert.match(orderRoute, /expected_quote_revision/, "repricing must be guarded by the revision, not just the status");
  assert.match(orderRoute, /status: 409/, "a mismatch must be a conflict");
});

test("the order route re-asserts the status inside the write", () => {
  /*
   * The early comparison is not enough on its own. Between the `select` and the
   * `update` a colleague's request can land, and only the `WHERE` clause sees
   * that. This is the assertion that would fail if someone "simplified" the
   * guard back to `.eq("id", id)`.
   */
  assert.match(
    orderRoute,
    /\.update\(update\)\.eq\("id", id\)\.eq\("status", existing\.status\)/,
    "the guarded update must re-assert the status it read"
  );
  assert.match(
    orderRoute,
    /guarded\.select\("id"\)\.maybeSingle\(\)/,
    "the write must report whether it matched a row"
  );
  assert.match(orderRoute, /if \(!written\)/, "a zero-row update must be detected, not treated as success");
});

test("a zero-row update tells staff where the order actually is", () => {
  assert.match(orderRoute, /Nothing was applied/, "a conflict must say the action did not take effect");
  assert.match(orderRoute, /conflict: true/);
});

test("every consequential order surface sends its expected state", () => {
  assert.match(orderPage, /expected_status: order\.status/, "the order page must send what it rendered from");
  assert.match(orderPage, /expected_quote_revision/, "quoting must send the revision it saw");
  assert.match(lifecyclePanel, /expected_status: record\.status/, "returns must send the return's state");
  assert.match(fulfillmentPanel, /expectedStatus: order\.fulfillmentStatus/);
});

test("the return route refuses a legal move made from a stale page", () => {
  /*
   * The transition graph alone cannot catch this. A return at `approved` that a
   * colleague advanced to `awaiting_shipment` still accepts "Mark received" from
   * a page showing `approved` — a legal move that skips a step.
   */
  assert.match(returnRoute, /expected_status/);
  assert.match(returnRoute, /conflict: true/);
  assert.match(returnRoute, /Reload the order before deciding/);
});

test("the routes that already had guards still have them", () => {
  // Pass 8 and 9 built these. This pass must not have loosened them.
  assert.match(fulfillmentRoute, /expected !== current/);
  assert.match(cancellationRoute, /\.eq\("status", "pending"\)/, "a decision must only apply to a pending request");
  assert.match(productionStatusRoute, /\.eq\("status", from\)/);
  assert.match(returnRoute, /\.eq\("status", record\.status\)/);
});

// ---------------------------------------------------------------------------
// Duplicate-action prevention
// ---------------------------------------------------------------------------

test("the dialog blocks a second submit synchronously", () => {
  /*
   * `pending` is state, and two clicks in one React batch both read the old
   * value. Only a ref checked and set in the same tick actually stops the second
   * call, which is the difference between "usually one email" and "one email".
   */
  assert.match(dialog, /const inFlight = useRef\(false\)/);
  assert.match(dialog, /if \(inFlight\.current \|\| !canSubmit\) return/);
  assert.match(dialog, /inFlight\.current = true/);
});

test("the dialog will not retry a stale action", () => {
  assert.match(
    dialog,
    /const canSubmit = !pending && !reasonMissing && !conflict/,
    "a conflict must remove the confirm button rather than re-arming it"
  );
  assert.match(dialog, /deliberately not retried for you/);
});

test("a message carries a token so a repeat send collapses", () => {
  assert.match(orderPage, /client_token: token/);
  assert.match(messageRoute, /client_token/);
  assert.match(messageRoute, /"23505"/, "a unique violation must be recognised as the same send");
  assert.match(messageRoute, /duplicate: true/);
});

test("the message token is sanitised before it reaches a unique index", () => {
  assert.match(messageRoute, /replace\(\/\[\^A-Za-z0-9_-\]\/g, ""\)/);
});

test("the message migration is additive and needs no backfill", () => {
  assert.match(messageMigration, /add column if not exists client_token text/);
  assert.match(messageMigration, /create unique index if not exists/);
  // Partial, so the historic rows that all carry null cannot collide with each
  // other — which is what makes this safe to add to a live table.
  assert.match(messageMigration, /where client_token is not null/);
  assert.doesNotMatch(messageMigration, /drop\s+(table|column|index)/i, "a migration in this pass must not drop anything");
  assert.doesNotMatch(messageMigration, /\bdelete\s+from\b/i);
  assert.doesNotMatch(messageMigration, /\bupdate\s+public\./i);
});

test("no consequential control on the order page can be pressed twice", () => {
  // Every remaining raw button that writes must carry its own disable.
  assert.match(orderPage, /disabled=\{savingInternal\}/);
  assert.match(orderPage, /disabled=\{sending \|\| !body\.trim\(\)\}/);
  assert.match(orderPage, /if \(sending \|\| !body\.trim\(\)\) return/);
});

test("refunds stay keyed so a retry cannot send money twice", () => {
  assert.match(lifecyclePanel, /idempotency_key/);
  assert.match(refundRoute, /idempotencyKey/);
  assert.match(cancellationRoute, /idempotencyKey: `cancellation-\$\{requestId\}-\$\{refundCents\}`/);
  assert.match(returnRoute, /idempotencyKey: `return-\$\{returnId\}-\$\{refundCents\}`/);
});

// ---------------------------------------------------------------------------
// Nothing writes on selection
// ---------------------------------------------------------------------------

test("no dropdown or checkbox on a consequential surface writes on change", () => {
  /*
   * The order page's status override is the one that mattered: a `<select>` next
   * to a button. The select still only sets local state; the button and its
   * dialog are what post.
   */
  assert.match(orderPage, /onChange=\{\(e\) => setPendingStatus\(e\.target\.value\)\}/);
  assert.doesNotMatch(orderPage, /onChange=\{[^}]*updateStatus/, "changing a dropdown must not update the order");
  assert.doesNotMatch(orderPage, /onChange=\{[^}]*patchOrder/);
  assert.doesNotMatch(lifecyclePanel, /onChange=\{[^}]*(?:post|onAction)\(/);
  assert.doesNotMatch(fulfillmentPanel, /onChange=\{[^}]*post\(/);
});

test("window.confirm and window.prompt are gone from the order workspace", () => {
  for (const [name, source] of Object.entries({ orderPage, lifecyclePanel, fulfillmentPanel })) {
    assert.doesNotMatch(source, /window\.confirm/, `${name} still uses window.confirm`);
    assert.doesNotMatch(source, /window\.prompt/, `${name} still uses window.prompt`);
  }
});

// ---------------------------------------------------------------------------
// Customer-visible and internal text stay apart
// ---------------------------------------------------------------------------

test("the dialog labels which note the customer reads", () => {
  assert.match(dialog, /The customer reads this exactly as written/);
  assert.match(dialog, /never sent to the customer/i);
});

test("the composer says which of the two things it is about to do", () => {
  assert.match(orderPage, /Stays on this order\. No email, no notification\./);
  assert.match(orderPage, /The customer reads this and is emailed a copy\./);
  // The two paths have different buttons, so "Send" cannot mean either.
  assert.match(orderPage, /Save internal note/);
  assert.match(orderPage, /label="Send to customer"/);
});

test("an internal note never reaches a customer notification", () => {
  assert.match(
    messageRoute,
    /if \(!internal\) \{/,
    "the email block must be inside the not-internal branch"
  );
  assert.match(lifecyclePanel, /internal_note: privateNote/);
  // The lifecycle sender's only customer-facing free text is `detail`, and the
  // panel never passes an internal note into it.
  assert.doesNotMatch(lifecyclePanel, /detail: *internalNote/);
});

// ---------------------------------------------------------------------------
// The legacy fulfillment write path
// ---------------------------------------------------------------------------

test("shipment_action can no longer ship an order", () => {
  /*
   * It only required `orders.manage`, while handing goods over needs
   * `fulfillment.manage` — and it never wrote `fulfillment_status`, so an order
   * shipped through it stayed "unfulfilled" to the cancellation and return rules
   * and still looked cancellable.
   */
  assert.doesNotMatch(orderRoute, /shipped_at = /, "the route must not stamp a shipment any more");
  assert.doesNotMatch(orderRoute, /update\.delivered_at/);
  assert.match(orderRoute, /status: 410/, "the retired action must answer Gone, not be silently ignored");
  assert.doesNotMatch(orderRoute, /order_shipped|order_delivered/, "shipping emails belong to the fulfillment route");
});

test("fulfillment has exactly one write path and it checks its own permission", () => {
  assert.match(fulfillmentRoute, /requirePermission\(req, "fulfillment\.manage"\)/);
  assert.match(orderRoute, /requirePermission\(req, "orders\.manage"\)/);
});

// ---------------------------------------------------------------------------
// Accessibility and interaction
// ---------------------------------------------------------------------------

test("the dialog is a real dialog", () => {
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby=\{headingId\}/);
  assert.match(dialog, /aria-describedby=\{describedId\}/);
});

test("focus is trapped while open and restored on close", () => {
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /triggerRef\.current\?\.focus\(\)/);
});

test("the dialog is portalled out of the panel it was opened from", () => {
  /*
   * Not cosmetic. `SiteHeader` carries `transition-transform`, which makes it a
   * containing block for `position: fixed`; anything fixed rendered inside a
   * transformed ancestor is clipped to it. Portalling to `document.body` is what
   * keeps a dialog full-screen wherever it is opened from.
   */
  assert.match(dialog, /createPortal\(dialog, document\.body\)/);
});

test("every button in the workspace states its type", () => {
  // A bare <button> inside a form submits it. The composer is no longer a form
  // at all, and the remaining buttons say what they are.
  const bare = orderPage.match(/<button(?![^>]*type=)[^>]*>/g) ?? [];
  assert.deepEqual(bare, [], `these buttons have no explicit type: ${bare.join(", ")}`);
  assert.doesNotMatch(orderPage, /<form/, "the conversation composer should not be a form");
});

test("the dialog works as a sheet on a phone", () => {
  assert.match(dialog, /items-end justify-center/, "it should sit at the bottom on a small screen");
  assert.match(dialog, /sm:items-center/);
  assert.match(dialog, /overflow-y-auto/, "a long confirmation must scroll rather than clip");
});
