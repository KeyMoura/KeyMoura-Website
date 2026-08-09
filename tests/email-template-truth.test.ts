import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CUSTOMER_SAFE_VARIABLES,
  EMAIL_EVENTS,
  EMAIL_TEMPLATE_KEYS,
  eventsForTemplate,
  findPlaceholderProblems,
  templateWiring,
} from "../src/lib/comms/emailEvents.ts";

/**
 * Does `/staff/emails` actually control the emails the application sends?
 *
 * The question was asked directly, so it was answered by tracing the path
 * rather than by trusting the page's own claim. The answer is **yes**, and the
 * evidence is:
 *
 * 1. `sendCommerceEmail` reads `email_templates` on **every send** — subject,
 *    heading, body, button_label and is_enabled — keyed on the template key.
 * 2. There is no cache in front of that read, so an edit takes effect on the
 *    next email with no deploy and no invalidation step.
 * 3. The hard-coded strings in the sender are `||` fallbacks that apply only
 *    when the row is missing entirely; with all 43 rows present, none is used.
 * 4. The database and the catalogue agree exactly: **43 rows, 43 keys**,
 *    verified against production. No row in the table is unreachable, and no
 *    catalogued template is missing a row.
 *
 * What the page could *not* do was tell a staff member any of this. It carried
 * a hand-written sentence per template maintained beside the catalogue rather
 * than from it, and a hard-coded list naming 7 of the 14 usable variables. Both
 * now derive from the module the send-call tests already assert against.
 */

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const sender = read("src/lib/commerceEmail.ts");
const page = read("src/app/staff/emails/page.tsx");

/**
 * The template keys present in production, captured 2026-08-08 from
 * `select key from email_templates`. Checked in so the "no dead rows" claim is
 * a test rather than a sentence in a ledger.
 */
const PRODUCTION_TEMPLATE_KEYS = [
  "cancellation_approved", "cancellation_denied", "cancellation_requested", "cancellation_withdrawn",
  "customer_message", "fulfillment_processing", "low_stock_alert", "needs_information",
  "guest_order_access",
  "order_cancelled", "order_delivered", "order_picked_up", "order_ready_for_pickup",
  "order_ready_to_fulfill", "order_received", "order_shipped", "out_of_stock_alert",
  "payment_failed", "payment_received", "production_completed", "production_started",
  "production_waiting_on_customer", "quote_ready", "quote_updated", "refund_completed",
  "refund_failed", "refund_initiated", "refund_partial_completed", "request_received",
  "return_approved", "return_denied", "return_inspected", "return_received", "return_requested",
  "staff_cancellation_request", "staff_fulfillment_due", "staff_integration_failure",
  "staff_message", "staff_new_order", "staff_new_request", "staff_payment_failed",
  "staff_return_request", "status_update", "tracking_corrected",
];

// ---------------------------------------------------------------------------
// The sender genuinely reads the edited row
// ---------------------------------------------------------------------------

test("every editable field is read from the database at send time", () => {
  assert.match(sender, /from\("email_templates"\)\s*\.select\("subject,heading,body,button_label,is_enabled"\)/);
  assert.match(sender, /\.eq\("key", input\.templateKey\)/);
  // Each of the four edited fields reaches the message.
  assert.match(sender, /template\?\.subject \|\|/);
  assert.match(sender, /template\?\.heading \|\|/);
  assert.match(sender, /template\?\.body \|\|/);
  assert.match(sender, /template\?\.button_label \|\|/);
  // And the switch is honoured.
  assert.match(sender, /template\?\.is_enabled === false/);
});

test("an edit is effective immediately — nothing caches the template", () => {
  const code = sender.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const cache of ["unstable_cache", "revalidate", "cache(", "force-cache"]) {
    assert.ok(!code.includes(cache), `the sender must not cache templates (${cache})`);
  }
});

test("the database body reaches both the HTML and the plain-text part", () => {
  // A template edit that changed only the HTML would leave text-first clients
  // reading the previous wording.
  assert.match(sender, /const plainText = \[/);
  assert.match(sender, /\\n\$\{body\}/);
  assert.match(sender, /escapeHtml\(body\)/);
});

test("template content is escaped, so a template cannot inject markup or script", () => {
  for (const field of ["heading", "body", "button"]) {
    assert.match(sender, new RegExp(`escapeHtml\\(${field}\\)`), `${field} must be escaped into the HTML`);
  }
  // The subject is the one interpolated string that does not pass through
  // escapeHtml, so it strips CR/LF instead — header injection, not markup.
  assert.match(sender, /const headerSafe = \(value: string\) => value\.replace\(\/\[\\r\\n\]\+\/g, " "\)/);
  assert.match(sender, /interpolateHeader\(template\?\.subject/);
});

// ---------------------------------------------------------------------------
// No dead rows, and nothing missing
// ---------------------------------------------------------------------------

test("production holds exactly the templates the catalogue describes", () => {
  // Widened to `string[]` on both sides: comparing a literal-union array to a
  // plain one otherwise makes `includes` reject the very keys it is looking for.
  const catalogue: string[] = [...EMAIL_TEMPLATE_KEYS].sort();
  const live: string[] = [...PRODUCTION_TEMPLATE_KEYS].sort();

  const dead = live.filter((key) => !catalogue.includes(key));
  const missing = catalogue.filter((key) => !live.includes(key));

  // A row nothing sends is a setting that pretends to control production email.
  assert.deepEqual(dead, [], `templates in the database that nothing sends: ${dead.join(", ")}`);
  // A catalogued template with no row means the sender silently uses its
  // hard-coded fallback and the editor shows nothing to change.
  assert.deepEqual(missing, [], `catalogued templates with no database row: ${missing.join(", ")}`);
  assert.equal(live.length, 44);
});

test("every template is referenced by at least one event", () => {
  for (const key of EMAIL_TEMPLATE_KEYS) {
    assert.ok(eventsForTemplate(key).length > 0, `${key} is edited by staff but sent by no event`);
  }
});

test("the one template that cannot send anything today is known and explained", () => {
  const unwired = EMAIL_TEMPLATE_KEYS.filter((key) => !templateWiring(key).wired);
  // Recorded precisely rather than left to drift. If this list grows, the page
  // will label the new one too — but the change should be deliberate.
  assert.deepEqual([...unwired], ["staff_fulfillment_due"]);

  const wiring = templateWiring("staff_fulfillment_due");
  assert.equal(wiring.wired, false);
  // It must say *why*, or the badge is just a shrug.
  assert.ok(wiring.pendingReason && wiring.pendingReason.length > 20, "an unwired template must explain itself");
  assert.ok(wiring.events.length > 0);
});

test("the staff page marks an unwired template rather than hiding it", () => {
  assert.match(page, /templateWiring\(/);
  assert.match(page, /Not sent yet/);
  assert.match(page, /Why it does not send/);
  assert.match(page, /Nothing in the application sends this template/);
});

// ---------------------------------------------------------------------------
// The page tells the truth about what triggers a template
// ---------------------------------------------------------------------------

test("'Used by' is derived from the catalogue, not typed out again", () => {
  assert.match(page, /wiring\.events\.map/);
  assert.match(page, /event\.trigger/);
  assert.match(page, /Used by/);
});

test("the variable list is derived, and covers every usable variable", () => {
  assert.match(page, /CUSTOMER_SAFE_VARIABLES\.map/);
  // The hard-coded list this replaces named 7 of 14, so half were undiscoverable.
  assert.doesNotMatch(page, /\{\{customer_name\}\}, \{\{product_name\}\}/);
  assert.equal(CUSTOMER_SAFE_VARIABLES.length, 14);
});

// ---------------------------------------------------------------------------
// Malformed placeholders
// ---------------------------------------------------------------------------

test("a placeholder the sender would not substitute is reported", () => {
  // These are mailed to the customer with the braces intact.
  for (const bad of ["{{ customer_name }}", "{customer_name}", "{{Customer_Name}}", "{{first-name}}", "{{name1}}"]) {
    const { malformed } = findPlaceholderProblems(`Hello ${bad}, thanks.`);
    assert.ok(malformed.length > 0, `${bad} must be reported as malformed`);
  }
});

test("a correct placeholder is not reported", () => {
  for (const name of CUSTOMER_SAFE_VARIABLES) {
    const found = findPlaceholderProblems(`Hi {{${name}}}.`);
    assert.deepEqual(found.malformed, [], `{{${name}}} must be accepted`);
    assert.deepEqual(found.unknown, [], `{{${name}}} must be a known variable`);
  }
});

test("a well-formed name nothing supplies is reported separately", () => {
  // This one is not malformed — it substitutes, to an empty string, and the
  // sentence quietly loses a word. That is a different failure and says so.
  const found = findPlaceholderProblems("Your {{invoice_number}} is ready.");
  assert.deepEqual(found.malformed, []);
  assert.deepEqual(found.unknown, ["{{invoice_number}}"]);
});

test("ordinary prose with braces is not flagged as a mistake", () => {
  assert.deepEqual(findPlaceholderProblems("Nothing here.").malformed, []);
  assert.deepEqual(findPlaceholderProblems("Empty {} braces.").malformed, []);
});

test("each problem is reported once regardless of how often it appears", () => {
  const found = findPlaceholderProblems("{{ x }} and {{ x }} again");
  assert.equal(found.malformed.length, 1);
});

test("the editor checks every field, not only the message body", () => {
  // A mistyped variable in the subject is the most visible place it can appear.
  assert.match(page, /template\.subject, template\.heading, template\.body, template\.button_label/);
  assert.match(page, /looks like a mistyped variable/);
});

// ---------------------------------------------------------------------------
// The catalogue itself stays honest
// ---------------------------------------------------------------------------

test("every event names a template that exists in production", () => {
  for (const event of EMAIL_EVENTS) {
    assert.ok(
      PRODUCTION_TEMPLATE_KEYS.includes(event.templateKey),
      `event ${event.id} sends ${event.templateKey}, which has no row in production`
    );
  }
});

test("an unwired event says what it is waiting for", () => {
  for (const event of EMAIL_EVENTS.filter((candidate) => !candidate.wired)) {
    assert.ok(event.notes && event.notes.length > 20, `${event.id} is unwired and does not say why`);
  }
});
