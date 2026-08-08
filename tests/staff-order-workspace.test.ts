import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { emptyFilters, savedView } from "../src/lib/staff/orderFilters.ts";
import { buildQueryPlan } from "../src/lib/staff/orderQueryPlan.ts";

const read = (path:string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("workspace migration keeps operational data staff-only", () => {
  const sql = read("supabase/migrations/20260731210000_staff_order_workspace.sql");
  for (const table of ["order_workspaces", "order_checklist_items", "order_cost_items"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /is_staff_user\(\)/);
  assert.doesNotMatch(sql, /to anon/);
  assert.match(sql, /priority in \('low','normal','high','urgent'\)/);
  assert.match(sql, /unit_cost_cents >= 0/);
});

test("workspace API validates every mutation behind order management permission", () => {
  const route = read("src/app/api/staff/orders/[id]/workspace/route.ts");
  assert.match(route, /requirePermission\(req, "orders\.manage"\)/);
  for (const action of ["save_workspace", "add_checklist", "toggle_checklist", "delete_checklist", "add_cost", "delete_cost"]) {
    assert.match(route, new RegExp(action));
  }
  assert.match(route, /Number\.isInteger\(unitCostCents\)/);
  assert.match(route, /\.eq\("order_id", id\)/);
});

test("staff UI exposes planning, costs, job sheet, and priority filtering", () => {
  const detail = read("src/components/staff/StaffOrderWorkspace.tsx");
  const list = read("src/app/staff/orders/page.tsx");
  for (const label of ["Production workspace", "Production checklist", "Materials & costs", "Print job sheet", "Assigned to"]) assert.match(detail, new RegExp(label));
  assert.match(detail, /window\.print\(\)/);

  /*
   * Priority filtering moved to the server, so the old "All priorities" option
   * label and the page's own `order_workspaces` select are gone. The property
   * worth pinning is not the wording — it is that priority is *filterable* and
   * that the workspace row still reaches the queue.
   */
  assert.match(list, /PRIORITIES/, "the queue must still offer priority filtering");
  assert.match(list, /Any priority/);
  const plan = buildQueryPlan({ ...emptyFilters(), priority: ["urgent"] });
  assert.deepEqual(plan.predicates, [{ op: "in", column: "priority", values: ["urgent"] }]);
  const sql = read("supabase/migrations/20260806010000_staff_order_queue_view.sql");
  assert.match(sql, /left join public\.order_workspaces/, "priority comes from the workspace row");
});

test("staff order queue separates staff actions from customer waits", () => {
  /*
   * Re-pointed from the old two-tab strip ("Needs action" / "Waiting") onto the
   * saved views, and made stricter: the distinction is now asserted against the
   * filter module rather than against JSX wording, and it checks the *rule*
   * rather than the label — work the shop owes the customer is separated from
   * work the shop is waiting on the customer for.
   */
  const needsReview = savedView("needs_review");
  const awaitingInformation = savedView("awaiting_information");
  const awaitingPayment = savedView("awaiting_payment");
  assert.ok(needsReview && awaitingInformation && awaitingPayment);

  // Staff-owed work: a new request nobody has looked at.
  assert.deepEqual(needsReview.filters.status, ["requested"]);
  assert.equal(needsReview.group, "Attention");

  // Customer-owed waits: distinct views, and neither is in the Attention queue,
  // because nothing on them is actionable by staff today.
  assert.deepEqual(awaitingInformation.filters.status, ["needs_information"]);
  assert.deepEqual(awaitingPayment.filters.status, ["awaiting_payment"]);

  // The two must never resolve to the same set of orders.
  const staffWork = new Set(buildQueryPlan({ ...emptyFilters(), view: "needs_review" } as never).predicates.map((p) => JSON.stringify(p)));
  const customerWait = buildQueryPlan({ ...emptyFilters(), view: "awaiting_information" } as never).predicates.map((p) => JSON.stringify(p));
  assert.ok(customerWait.every((p) => !staffWork.has(p)), "the two queues must not select the same orders");
});

test("staff order detail leads with the next action and hides manual overrides", () => {
  const detail = read("src/app/staff/orders/[id]/page.tsx");
  assert.match(detail, /Next step/);
  assert.match(detail, /Customer quote/);
  assert.match(detail, /Advanced status override/);
  assert.match(detail, /Quote Review/);
  assert.match(detail, /Finished Product Review/);
  assert.match(detail, /not your material or labor cost/);
});

test("the order workspace is tabbed, and the next step points at a tab", () => {
  const detail = read("src/app/staff/orders/[id]/page.tsx");
  /*
   * The page was one column of eleven panels — a stepper, a workspace, a shop
   * work list, a review composer, the lifecycle panel, the quote editor, the
   * fulfillment panel, the conversation, a timeline, an email log and an
   * override — all mounted at once. Every one of those still exists; each now
   * lives on exactly one tab.
   */
  for (const id of [
    "overview",
    "items",
    "payment",
    "production",
    "fulfillment",
    "messages",
    "returns",
    "activity",
  ]) {
    assert.match(detail, new RegExp(`<TabPanel id="${id}"`), `no panel for the ${id} tab`);
  }
  // "Next step" moves the reader to the tab that holds the control, rather
  // than to an anchor 2,000 pixels down a single page.
  assert.match(detail, /setTab\(nextStep\.tab\)/);
  assert.match(detail, /tab: "payment"/);
  assert.match(detail, /tab: "fulfillment"/);
});

test("no state is rendered on two tabs at once", () => {
  const detail = read("src/app/staff/orders/[id]/page.tsx");
  /*
   * The lifecycle panel drew a four-tile financial summary and the page header
   * drew its own, so "how much has this customer paid" had two answers on one
   * screen. The panel is now asked for one half at a time: money on Payment,
   * decisions on Returns & cancellations.
   */
  assert.match(detail, /view="money"/);
  assert.match(detail, /view="lifecycle"/);
  const panel = read("src/components/staff/OrderLifecyclePanel.tsx");
  assert.match(panel, /const showMoney = view === "all" \|\| view === "money"/);
  assert.match(panel, /const showLifecycle = view === "all" \|\| view === "lifecycle"/);
});

test("retired anchors still land on the tab that replaced them", () => {
  // `#fulfillment` is linked from the fulfillment queue, `#quote` from the old
  // next-step button, `#conversation` from anywhere a colleague pasted a link.
  const framework = read("src/lib/staff/pageFramework.ts");
  assert.match(framework, /conversation: "messages"/);
  assert.match(framework, /quote: "payment"/);
  assert.match(framework, /"shop-work": "production"/);
  assert.match(read("src/app/staff/orders/[id]/page.tsx"), /ORDER_TAB_ALIASES/);
});
