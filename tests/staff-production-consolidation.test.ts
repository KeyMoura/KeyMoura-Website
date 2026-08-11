import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * Every negative assertion below must run against this rather than the raw
 * file. These components explain *in prose* why they do not carry a priority,
 * an assignee or a start flag — so a naive `doesNotMatch(/priority/)` on the
 * whole file fails on the very comment that documents the absence, and the only
 * way to make it pass would be to delete the explanation. Strip first, then
 * assert on what actually ships.
 */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * One production workflow, not two.
 *
 * The order page used to mount `OrderProductionJobs` (the real system —
 * `production_jobs`, with job numbers, statuses, tasks, events and files) and
 * `StaffOrderWorkspace` (an older `order_workspaces` / `order_checklist_items`
 * pair) on the **same Production tab**, each with its own priority, its own
 * assignee, its own start flag and its own task list. Whether a thing was being
 * made had two answers, and neither surface said which one the shop floor used.
 *
 * These tests hold the split that fixed it:
 *
 * - `production_jobs` owns production state.
 * - The order owns triage (priority + owner), because `staff_order_queue`
 *   filters and sorts on it and an order with no shop work still has an owner.
 * - `order_cost_items` survives as costing, because nothing on `production_jobs`
 *   adds up to money and there are real rows in it.
 */

const ORDER_PAGE = "src/app/staff/orders/[id]/page.tsx";

test("the retired workspace panel is gone and nothing imports it", () => {
  assert.throws(
    () => read("src/components/staff/StaffOrderWorkspace.tsx"),
    "StaffOrderWorkspace.tsx must not come back — production state belongs to production_jobs"
  );
  const page = read(ORDER_PAGE);
  assert.doesNotMatch(page, /StaffOrderWorkspace/);
  assert.doesNotMatch(page, /Production workspace/);
});

test("the Production tab shows shop work and costing, and no second state machine", () => {
  const page = read(ORDER_PAGE);

  // The canonical system is mounted.
  assert.match(page, /<OrderProductionJobs/, "the Production tab must show the real production jobs");
  // Costing survives, named for what it is.
  assert.match(page, /title="Job costing"/);
  assert.match(page, /<OrderCostingPanel/);

  /*
   * The load-bearing negative: the costing panel must not have grown a status,
   * priority or assignee control. Those are the four fields whose duplication
   * was the entire defect.
   */
  const costing = code("src/components/staff/OrderCostingPanel.tsx");
  assert.doesNotMatch(costing, /priority/i, "costing must not carry a second priority");
  assert.doesNotMatch(costing, /assigned_to/, "costing must not carry a second assignee");
  assert.doesNotMatch(costing, /Production started/, "production start is production_jobs.started_at");
  assert.doesNotMatch(costing, /checklist/i, "tasks belong to production_job_tasks");
});

test("triage is an order property, on Overview, and never a production control", () => {
  const triage = read("src/components/staff/OrderTriagePanel.tsx");

  // It writes the order's workspace row — the one `staff_order_queue` reads.
  assert.match(triage, /action: "save_workspace"/);
  assert.match(triage, /priority/);
  assert.match(triage, /assigned_to/);

  /*
   * It must not reintroduce the start flag. The endpoint only preserves
   * `started_at` because this panel stops sending `started`; a panel that sent
   * it again would restore the second answer to "is this being made".
   */
  const triageCode = code("src/components/staff/OrderTriagePanel.tsx");
  assert.doesNotMatch(triageCode, /started/, "production start must not be settable from the order");
  assert.doesNotMatch(triageCode, /checklist/i);

  // And it is mounted on Overview, not Production.
  const page = read(ORDER_PAGE);
  const overview = page.slice(page.indexOf('<TabPanel id="overview"'), page.indexOf('<TabPanel id="items"'));
  assert.match(overview, /<OrderTriagePanel/, "triage belongs on Overview beside the order's own facts");
  const production = page.slice(
    page.indexOf('<TabPanel id="production"'),
    page.indexOf('<TabPanel id="fulfillment"')
  );
  assert.doesNotMatch(production, /<OrderTriagePanel/, "order triage on the Production tab is the old defect");
});

test("the workspace endpoint preserves started_at when the retired control omits it", () => {
  const route = read("src/app/api/staff/orders/[id]/workspace/route.ts");
  /*
   * `save_workspace` used to set `started_at = body.started ? … : null`, so a
   * caller that did not send the key silently cleared the timestamp. The triage
   * panel does not send it, so the absent case must preserve rather than clear.
   */
  assert.match(route, /hasOwnProperty\.call\(body, "started"\)/);
  assert.match(route, /currentWorkspace\?\.started_at \?\? null/);
  // The permission gate is unchanged.
  assert.match(route, /requirePermission\(req, "orders\.manage"\)/);
});

test("the order queue still resolves priority, and production status comes from the job", () => {
  const sql = read("supabase/migrations/20260806010000_staff_order_queue_view.sql");
  // Unchanged compatibility path: triage priority still feeds the queue.
  assert.match(sql, /left join public\.order_workspaces/);
  assert.match(sql, /priority_rank/);
  // And production state on the queue is already the job's, not the workspace's.
  assert.match(sql, /from public\.production_jobs j/);
  assert.match(sql, /as production_status/);
});

test("production hands off to fulfillment without owning it", () => {
  const page = read(ORDER_PAGE);
  const production = page.slice(
    page.indexOf('<TabPanel id="production"'),
    page.indexOf('<TabPanel id="fulfillment"')
  );
  /*
   * Production owns manufacturing completion; packing, carrier, tracking and
   * pickup belong to Fulfillment. The fulfillment panel must be mounted exactly
   * once, and not from inside Production.
   */
  assert.doesNotMatch(production, /OrderFulfillmentPanel/, "fulfillment controls must not live in Production");
  assert.equal(
    page.match(/<OrderFulfillmentPanel/g)?.length,
    1,
    "the fulfillment panel is mounted once, on its own tab"
  );
});
