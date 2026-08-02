import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("dashboard analytics and staff navigation use shared themed controls", () => {
  const dashboard = read("src/app/staff/page.tsx");
  const analytics = read("src/app/staff/info/analytics/page.tsx");
  const navigation = read("src/components/staff/StaffNav.tsx");

  for (const page of [dashboard, analytics]) {
    assert.match(page, /SegmentedControl/);
    assert.match(page, /MetricCard/);
    assert.doesNotMatch(page, /bg-brand-accent text-black/);
  }
  assert.match(navigation, /className="staff-nav/);
  assert.match(navigation, /className="staff-nav-link/);
});

test("catalog actions use the shared primary secondary and destructive hierarchy", () => {
  const catalog = read("src/app/staff/catalog/page.tsx");

  assert.match(catalog, /const primary = "ui-btn ui-btn-primary/);
  assert.match(catalog, /const subtle = "ui-btn ui-btn-ghost/);
  assert.match(catalog, /ui-btn ui-btn-danger/);
  assert.doesNotMatch(catalog, /const primary = .*text-brand-primary/);
});

test("customer and staff request flows share the same progress language", () => {
  const customerRequest = read("src/app/orders/new/page.tsx");
  const staffProposal = read("src/app/staff/orders/new/page.tsx");

  for (const page of [customerRequest, staffProposal]) {
    assert.match(page, /ui-stepper/);
    assert.match(page, /ui-step/);
    assert.match(page, /ui-btn ui-btn-primary/);
  }
});

test("appearance offers visual choices and previews the complete component system", () => {
  const appearance = read("src/app/staff/appearance/page.tsx");

  for (const expected of ["Starting point", "Layout & type", "Components", "Advanced palette", "Live appearance preview", "MetricCard", "ui-stepper", "ui-tabs", "Primary action", "Secondary action"]) {
    assert.ok(appearance.includes(expected), `missing appearance control or preview: ${expected}`);
  }
  assert.doesNotMatch(appearance, /<MenuSelect/);
  assert.match(appearance, /aria-pressed=\{value === item\}/);
});
