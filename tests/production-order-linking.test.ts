import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseJobDraft } from "../src/lib/production/jobs.ts";

/**
 * The link between a production job and the order it is being made for.
 *
 * ## The defect
 *
 * `production_jobs` has carried `order_id`, `order_item_id`, `product_id` and
 * `customer_id` since pass 5, and both surfaces displayed the link correctly.
 * Nothing could *change* it after the job was created — and one thing destroyed
 * it.
 *
 * `parseJobDraft` resolves each link column with `uuid(input.orderId)`, and
 * `uuid` answers `null` for an absent key. The job workspace's `toDraft` builds
 * fourteen fields and not one of them is a link, so every press of Save on the
 * details form sent a body with no `orderId` — and `PATCH` wrote
 * `order_id = null, order_item_id = null, product_id = null, customer_id = null`.
 *
 * Editing a note detached the job from its order. Nothing said so: the job
 * simply stopped appearing in that order's Shop work panel, and the audit entry
 * dutifully recorded `fields: ["order_id", …]` for anyone who thought to look.
 *
 * The first test below is the regression, expressed against the parser itself.
 */

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const patchRoute = read("src/app/api/staff/production/jobs/[id]/route.ts");
const linkRoute = read("src/app/api/staff/production/jobs/[id]/link/route.ts");
const listRoute = read("src/app/api/staff/production/jobs/route.ts");
const orderPanel = read("src/components/staff/production/OrderProductionJobs.tsx");
const workspace = read("src/app/staff/production/[id]/page.tsx");

test("the parser still reads a missing link as null — which is why PATCH must strip it", () => {
  // Not a bug in `parseJobDraft`: a create form legitimately posts no order.
  // The bug was letting that answer reach an UPDATE.
  const { draft } = parseJobDraft({ title: "Shift knob", status: "not_started" });
  assert.ok(draft);
  assert.equal(draft.order_id, null);
  assert.equal(draft.order_item_id, null);
  assert.equal(draft.product_id, null);
  assert.equal(draft.customer_id, null);
});

test("the job workspace's save still sends no link fields", () => {
  // If this ever changes, the strip below stops being load-bearing and this
  // test says so rather than leaving a silent dependency between two files.
  const toDraft = workspace.slice(workspace.indexOf("const toDraft"), workspace.indexOf("export default"));
  for (const field of ["orderId", "orderItemId", "productId", "customerId"]) {
    assert.doesNotMatch(toDraft, new RegExp(`\\b${field}\\b`), `toDraft must not send ${field}`);
  }
});

test("PATCH strips every link column, so a field save cannot detach a job", () => {
  // The exact repair: all four, by name, out of the update payload.
  for (const column of ["order_id", "order_item_id", "product_id", "customer_id"]) {
    assert.match(
      patchRoute,
      new RegExp(`${column}:\\s*_[A-Za-z]+`),
      `PATCH must destructure ${column} out of the fields it writes`
    );
  }
  // `status` was already stripped for the same reason; the pattern is shared.
  assert.match(patchRoute, /status:\s*_status/);

  // The write takes the stripped rest object, never the parsed draft. That is
  // the whole difference between the fixed route and the one that erased links,
  // and it is a one-word edit away from returning.
  assert.match(patchRoute, /\.update\(fields\)/);
  assert.doesNotMatch(patchRoute, /\.update\(draft\)/);
});

test("linking is its own endpoint with its own permission", () => {
  assert.match(linkRoute, /requirePermission\(req, "production\.manage"\)/);
  // Reading the queue must not carry the right to move work between orders.
  assert.doesNotMatch(linkRoute, /production\.view/);
});

test("an order must exist before a job can point at it", () => {
  // The guard against linking to the wrong order: an id that resolves to no row
  // is refused rather than stored and discovered later from the order side.
  assert.match(linkRoute, /\.from\("orders"\)/);
  assert.match(linkRoute, /No order with that reference exists\./);
  assert.match(linkRoute, /status: 404/);
  // And it must be a well-formed reference before the database is asked at all.
  assert.match(linkRoute, /That is not a valid order reference\./);
});

test("detaching is stated, never inferred", () => {
  // `null` is an instruction; a missing key is a malformed request. Conflating
  // them is precisely how the PATCH defect erased links.
  assert.match(linkRoute, /raw !== null && typeof raw !== "string"/);
  assert.match(linkRoute, /Send an order id, or null to unlink\./);
});

test("a relink that raced another one is refused, twice over", () => {
  // Once on the value the browser was showing…
  assert.match(linkRoute, /expectedOrderId/);
  assert.match(linkRoute, /conflict: true/);
  assert.match(linkRoute, /status: 409/);
  // …and again in the WHERE clause, so a change landing between the read and
  // the write matches zero rows instead of overwriting it.
  assert.match(linkRoute, /guarded\.is\("order_id", null\)\s*:\s*guarded\.eq\("order_id", job\.order_id\)/);
});

test("re-confirming the current link is not a write", () => {
  // A no-op that produced an audit entry would teach staff that the log records
  // things that did not happen.
  assert.match(linkRoute, /nextOrderId === job\.order_id/);
  assert.match(linkRoute, /changed: false/);
});

test("moving a job carries nothing across from the previous order", () => {
  // An `order_item_id` belongs to exactly one order; carried across a relink it
  // would point at a different customer's line.
  assert.match(linkRoute, /order_item_id: null/);
  // Product and customer are taken from the order that was just verified, never
  // from the request, so the columns cannot disagree about whose work this is.
  assert.match(linkRoute, /product_id: order\?\.product_id \?\? null/);
  assert.match(linkRoute, /customer_id: order\?\.customer_id \?\? null/);
});

test("a link change is recorded on both the timeline and the audit log", () => {
  assert.match(linkRoute, /recordJobAction\(/);
  assert.match(linkRoute, /eventType: nextOrderId \? "job\.linked" : "job\.unlinked"/);
  // The `staff.` prefix is what `logAuditEvent` retains; anything else is
  // silently dropped.
  assert.match(linkRoute, /auditType: "staff\.production\.job\.link"/);
  // Order numbers, not customer details — the audit log is read more widely
  // than the job page.
  const metadata = linkRoute.slice(linkRoute.indexOf("metadata: {"), linkRoute.indexOf("note: nextOrderId"));
  assert.doesNotMatch(metadata, /email|name|address|guest/i);
});

test("the queue can list standalone work, which is what the link picker offers", () => {
  assert.match(listRoute, /orderId === "none"/);
  assert.match(listRoute, /\.is\("order_id", null\)/);
  // The picker asks for exactly that, so it can never take a job away from
  // another order by accident.
  assert.match(orderPanel, /orderId=none/);
  assert.match(orderPanel, /expectedOrderId: null/);
});

test("the order panel distinguishes 'not loaded' from 'none exist'", () => {
  // Collapsing the two is how an empty list renders as a spinner that never
  // resolves.
  assert.match(orderPanel, /standalone === null/);
  assert.match(orderPanel, /standalone\.length === 0/);
  assert.match(orderPanel, /There is no unlinked shop work to attach\./);
});

test("both directions of the link are visible", () => {
  // From the order: the jobs raised against it, each opening the job.
  assert.match(orderPanel, /\/staff\/production\/\$\{job\.id\}/);
  // From the job: the order it belongs to, opening the order.
  assert.match(workspace, /\/staff\/orders\/\$\{job\.order_id\}/);
  assert.match(workspace, /Linked to/);
});

test("the panel stays read-only about status, and gated on manage for writes", () => {
  // Editing a job's state from the order page would be a second write path to
  // guard; the panel deliberately links out instead.
  assert.match(orderPanel, /canManage \? \(/);
  assert.doesNotMatch(orderPanel, /jobs\/\$\{[^}]+\}\/status/);
});
