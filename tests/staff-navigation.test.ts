import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff navigation organizes tools into task-based categories", () => {
  const navigation = read("src/components/staff/StaffNav.tsx");
  for (const category of ["Operations", "Customers & content", "Brand & communication", "Access & system"]) {
    assert.match(navigation, new RegExp(category.replace("&", "&")));
  }
  assert.match(navigation, /Settings overview/);
  assert.match(navigation, /Catalog & inventory/);
  assert.match(navigation, /Email & notifications/);
});

test("monitoring test is staff-only on both the page and API", () => {
  const settings = read("src/app/staff/settings/page.tsx");
  const route = read("src/app/api/staff/monitoring/test/route.ts");
  assert.match(settings, /permissions\.has\("security\.view"\)/);
  assert.match(route, /requirePermission\(request, "security\.view"\)/);
  assert.match(route, /Sentry\.captureException/);
  assert.match(route, /Sentry\.flush/);
});
