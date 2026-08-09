import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseJobDraft } from "../src/lib/production/jobs.ts";

/**
 * Creating and linking production work from an order.
 *
 * The relationship columns have existed since pass 5 and both surfaces already
 * *displayed* them. What did not work was doing anything useful with them: you
 * could raise a job from an order but the form never said which order, never
 * carried the quantity, and never recorded which line it was for; and you could
 * link existing work only if it belonged to no order at all, chosen from a bare
 * `<select>` that showed neither status nor current owner.
 *
 * The most important test here is the last group. Pass 14 found that saving a
 * job's details **detached it from its order**, because `parseJobDraft` resolves
 * absent keys to null and the details form sends no link fields. That is the
 * regression this suite exists to make impossible to reintroduce.
 */

const read = (path: string) => readFileSync(path, "utf8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const panel = read("src/components/staff/production/OrderProductionJobs.tsx");
const newJob = read("src/app/staff/production/new/page.tsx");
const jobForm = read("src/components/staff/production/JobForm.tsx");
const patchRoute = read("src/app/api/staff/production/jobs/[id]/route.ts");
const linkRoute = read("src/app/api/staff/production/jobs/[id]/link/route.ts");
const jobPage = read("src/app/staff/production/[id]/page.tsx");
const orderPage = read("src/app/staff/orders/[id]/page.tsx");

// ---------------------------------------------------------------------------
// From an order
// ---------------------------------------------------------------------------

test("the order page offers both creating and linking, and leads with creating", () => {
  assert.ok(panel.includes("Create production job"));
  assert.ok(panel.includes("Link existing job"));
  const create = panel.indexOf("Create production job");
  // Primary styling on the common act.
  const primaryBlock = panel.slice(create - 200, create);
  assert.ok(primaryBlock.includes("ui-btn-primary"), "creating is the primary action");
});

test("creating from an order carries everything the order already knows", () => {
  for (const key of ["orderId", "productId", "customerId", "orderNumber", "quantity"]) {
    assert.ok(panel.includes(`params.set("${key}"`) || panel.includes(`URLSearchParams({ ${key} }`), key);
  }
  // And the order page supplies the two that are new.
  assert.match(orderPage, /orderNumber=\{order\.order_number\}/);
  assert.match(orderPage, /quantity=\{order\.quantity\}/);
});

test("the new-job form names the source order rather than alluding to it", () => {
  assert.ok(
    !code(newJob).includes("linked to the order it was raised from"),
    "an unnamed order cannot be checked by the person about to create work against it"
  );
  assert.match(newJob, /Source order:/);
  assert.match(newJob, /href=\{`\/staff\/orders\/\$\{orderId\}`\}/);
});

test("quantity is prefilled from the order, not defaulted to one", () => {
  assert.match(newJob, /presetQuantity && Number\(presetQuantity\) > 0/);
  assert.match(newJob, /String\(Math\.trunc\(Number\(presetQuantity\)\)\)/);
});

test("the job title distinguishes one order's work from another's", () => {
  assert.match(newJob, /orderNumber \? `\$\{presetTitle\} — \$\{orderNumber\}` : presetTitle/);
});

test("the order item travels with the job", () => {
  // `parseJobDraft` has always accepted it; nothing ever sent it, so every job
  // pointed at an order but never at a line within it.
  assert.match(newJob, /const orderItemId = params\.get\("orderItemId"\)/);
  assert.match(newJob, /orderId, orderItemId, productId, customerId/);
});

test("a second job on one order is allowed but never accidental", () => {
  assert.match(panel, /already has \{openJobs\.length\} open production/);
  assert.match(panel, /openJobs = \(jobs \?\? \[\]\)\.filter/);
  // Completed and cancelled work does not count as a duplicate.
  assert.match(panel, /\["completed", "cancelled"\]\.includes\(job\.status\)/);
});

// ---------------------------------------------------------------------------
// Linking existing work
// ---------------------------------------------------------------------------

test("the picker searches instead of listing", () => {
  assert.match(panel, /type="search"/);
  assert.match(panel, /query\.set\("q", search\.trim\(\)\)/);
  // Debounced: each keystroke is a round trip to a staff endpoint.
  assert.match(panel, /setTimeout\(\(\) => void loadCandidates\(term\), 300\)/);
  assert.ok(!code(panel).includes("<select"), "a bare select showed neither status nor current owner");
});

test("every candidate states its status and where it currently lives", () => {
  assert.match(panel, /<StatusBadge status=\{job\.status\} \/>/);
  assert.match(panel, /On order \$\{orderNumbers\[job\.order_id\]/);
  // "Not linked" is said in words — silence there reads as a failed lookup.
  assert.ok(panel.includes('"Not linked"'));
});

test("jobs already on this order are not offered as candidates", () => {
  assert.match(panel, /\.filter\(\(job: Job\) => job\.order_id !== orderId\)/);
});

test("moving a job off another order needs a confirmation naming both", () => {
  assert.match(panel, /setConfirming\(job\)/);
  assert.match(panel, /Move \$\{confirming\.job_number\} off order/);
  assert.ok(panel.includes("Move it here"));
  assert.ok(panel.includes("Cancel"));
});

test("the link request carries the state the reader was shown", () => {
  // Not a hardcoded null any more: relinking has to declare where it believes
  // the job is, or the server's stale check has nothing to compare against.
  assert.match(panel, /expectedOrderId: job\.order_id \?\? null/);
  assert.ok(!/expectedOrderId: null \}\)/.test(code(panel)));
});

test("the server refuses a stale relink rather than applying it", () => {
  assert.match(linkRoute, /hasOwnProperty\.call\(body, "expectedOrderId"\)/);
  assert.match(linkRoute, /status: 409/);
  // And re-asserts it in the WHERE clause, so the write itself is the race check.
  assert.match(linkRoute, /job\.order_id === null \? guarded\.is\("order_id", null\) : guarded\.eq\("order_id", job\.order_id\)/);
});

test("an order that does not resolve is refused before anything is stored", () => {
  assert.match(linkRoute, /No order with that reference exists/);
  assert.match(linkRoute, /status: 404/);
});

test("a move clears the order item, which belongs to exactly one order", () => {
  assert.match(linkRoute, /order_item_id: null/);
});

test("re-confirming the current link is not a write", () => {
  assert.match(linkRoute, /if \(nextOrderId === job\.order_id\)/);
  assert.match(linkRoute, /changed: false/);
});

test("linking is audited, with order numbers and no customer detail", () => {
  assert.match(linkRoute, /auditType: "staff\.production\.job\.link"/);
  assert.match(linkRoute, /orderNumber: order\?\.order_number \?\? null/);
  assert.ok(!/customer_email|guest_email/.test(linkRoute));
});

test("linking needs the production management permission", () => {
  assert.match(linkRoute, /requirePermission\(req, "production\.manage"\)/);
  assert.match(panel, /permissions\.has\("production\.manage"\)/);
});

// ---------------------------------------------------------------------------
// From production
// ---------------------------------------------------------------------------

test("a linked job shows its source order prominently, with a live link", () => {
  assert.match(jobPage, /Source order/);
  assert.match(jobPage, /href=\{`\/staff\/orders\/\$\{job\.order_id\}`\}/);
  assert.match(jobPage, /Order \{sourceOrder\.order_number/);
  // And says so in words when there is none, rather than rendering nothing.
  assert.ok(jobPage.includes("No source order"));
});

test("the job page can open the order it was raised from", () => {
  assert.match(jobPage, /Open order/);
  assert.match(jobPage, /#production/, "it lands on the order's Production tab");
});

// ---------------------------------------------------------------------------
// The relationship survives editing — the pass-14 regression
// ---------------------------------------------------------------------------

test("the details form has no control for any link column", () => {
  // This is the property that makes an ordinary save safe. If a link field ever
  // appears here, `parseJobDraft` will start resolving it from form state.
  for (const field of ["orderId", "order_id", "orderItemId", "productId", "customerId"]) {
    assert.ok(!jobForm.includes(field), `JobForm must not edit ${field}`);
  }
});

test("PATCH strips every link column before writing", () => {
  /*
   * Stripped by destructuring rather than by `delete`, which is the stronger
   * mechanism: `fields` is built from what is left over, so a link column
   * cannot reach the update even if a future edit adds one to the draft type —
   * whereas a forgotten `delete` fails silently.
   */
  const stripped = code(patchRoute).match(/const \{([\s\S]*?)\.\.\.fields\s*\} = draft;/);
  assert.ok(stripped, "PATCH must destructure the link columns out of the draft");
  for (const column of ["status", "order_id", "order_item_id", "product_id", "customer_id"]) {
    assert.ok(stripped[1].includes(`${column}:`), `${column} must be removed before the write`);
  }
  // And the thing actually written is the remainder, never the draft.
  assert.ok(!/\.update\(\{?\s*\.\.\.draft/.test(code(patchRoute)), "the draft itself must never be written");
});

test("an absent link key becomes null, which is why PATCH must strip them", () => {
  // The mechanism behind the pass-14 defect, pinned so the reason the stripping
  // exists cannot be forgotten and the stripping removed as redundant.
  const { draft } = parseJobDraft({ title: "Make a knob" });
  assert.ok(draft);
  assert.equal(draft.order_id, null);
  assert.equal(draft.order_item_id, null);
  assert.equal(draft.product_id, null);
  assert.equal(draft.customer_id, null);
});

test("a draft that does send the links keeps them", () => {
  const { draft } = parseJobDraft({
    title: "Make a knob",
    orderId: "11111111-1111-4111-8111-111111111111",
    orderItemId: "22222222-2222-4222-8222-222222222222",
    productId: "33333333-3333-4333-8333-333333333333",
    customerId: "44444444-4444-4444-8444-444444444444",
    quantity: 6,
  });
  assert.ok(draft);
  assert.equal(draft.order_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(draft.order_item_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(draft.quantity, 6);
});

test("a malformed link id becomes null rather than being stored", () => {
  const { draft } = parseJobDraft({ title: "Make a knob", orderId: "not-a-uuid" });
  assert.ok(draft);
  assert.equal(draft.order_id, null, "a mistyped reference must not be written as though it were real");
});

test("quantity is validated, not coerced", () => {
  for (const bad of [0, -3, 1.5, "many"]) {
    const { draft, errors } = parseJobDraft({ title: "x", quantity: bad });
    assert.equal(draft, null, String(bad));
    assert.ok(errors.some((problem) => /whole number/.test(problem)), String(bad));
  }
});
