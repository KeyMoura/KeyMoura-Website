import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("staff order queue supports useful independent sort modes", () => {
  const page = read("src/app/staff/orders/page.tsx");
  for (const label of ["Recently updated", "Newest orders", "Oldest orders", "Highest priority", "Target date", "Highest price"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /\.toSorted\(/);
});

test("customer order hub supports customer-safe sort modes", () => {
  const page = read("src/app/orders/page.tsx");
  for (const label of ["Recently updated", "Newest request", "Oldest request", "Needs attention first", "Price: high to low", "Price: low to high"]) {
    assert.match(page, new RegExp(label));
  }
  assert.doesNotMatch(page, /Highest priority/);
  assert.match(page, /created_at,updated_at/);
});

test("primary order and notification controls adapt for mobile", () => {
  const orders = read("src/app/orders/page.tsx");
  const notifications = read("src/app/notifications/page.tsx");
  assert.match(orders, /sm:w-auto/);
  assert.match(orders, /min-w-0 flex-1/);
  assert.match(notifications, /aria-pressed=\{showUnreadOnly\}/);
  assert.match(notifications, /min-h-11/);
});

test("account security exposes safe Supabase identity linking", () => {
  const page = read("src/app/account/page.tsx");
  assert.match(page, /getUserIdentities\(\)/);
  assert.match(page, /linkIdentity\(/);
  assert.match(page, /unlinkIdentity\(/);
  assert.match(page, /identities\.length < 2/);
  assert.match(page, /\["google", "discord"\]/);
  assert.match(page, /`Connect \$\{label\}`/);
});

test("appearance is organized into focused sections with explicit publishing", () => {
  const page = read("src/app/staff/appearance/page.tsx");
  for (const label of ["Brand & business", "Logos & icons", "Labels & wording", "Colors & controls"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /Reset this section/);
  assert.match(page, /Publish appearance/);
  assert.match(page, /You have unpublished appearance changes/);
  for (const label of ["Layout & type", "Components", "Tabs", "Cards & panels", "Inputs", "Navigation", "Content width"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /"framed"/);
});

test("account tabs use the shared configurable tab system", () => {
  const page = read("src/app/account/page.tsx");
  assert.match(page, /className="ui-tabs/);
  assert.match(page, /className=\{`ui-tab/);
  assert.match(page, /role="tab"/);
  assert.match(page, /aria-selected=/);
});
