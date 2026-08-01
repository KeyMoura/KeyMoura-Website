import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.match(list, /All priorities/);
  assert.match(list, /order_workspaces/);
});

test("staff order queue separates staff actions from customer waits", () => {
  const list = read("src/app/staff/orders/page.tsx");
  assert.match(list, /Needs action/);
  assert.match(list, /Waiting on customer/);
  assert.match(list, /Quote Review/);
  assert.match(list, /Finished Product Review/);
  assert.match(list, /needsStaffAction/);
  assert.match(list, /isWaitingOnCustomer/);
});
