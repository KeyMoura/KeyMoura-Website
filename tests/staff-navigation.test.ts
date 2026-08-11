import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { PERMISSIONS } from "../src/lib/permissions.ts";
import {
  PRIMARY_STAFF_NAV_ITEMS,
  STAFF_AREA_PERMISSIONS,
  STAFF_NAV,
  STAFF_NAV_ITEMS,
  activeStaffNavItem,
  canUseStaffArea,
  isStaffNavItemActive,
  primaryStaffNav,
  staffBreadcrumbs,
  staffSettingsSections,
  visibleStaffHrefs,
  visibleStaffNav,
} from "../src/lib/staffNavigation.ts";

/**
 * The staff information architecture.
 *
 * These assert the *rules*, not the rendering. The suite this replaces
 * string-matched group labels out of the sidebar's JSX, which is how
 * `/staff/settings/commerce` came to be listed in the settings index and in
 * neither the sidebar nor the context bar without anything noticing.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const exists = (path: string) => existsSync(new URL(`../${path}`, import.meta.url));

/**
 * Source with comments removed.
 *
 * Several assertions below prove that a call is *absent*, and these files
 * explain what they replaced. Matching the prose about a removed API is not the
 * same as matching the API.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ALL = new Set<string>(PERMISSIONS);

// ---------------------------------------------------------------------------
// Every destination is real
// ---------------------------------------------------------------------------

test("every navigation href resolves to a page that exists", () => {
  for (const item of STAFF_NAV_ITEMS) {
    const route = item.href === "/staff" ? "src/app/staff/page.tsx" : `src/app${item.href}/page.tsx`;
    assert.ok(exists(route), `${item.href} is in the staff menu but ${route} does not exist`);
  }
});

test("no navigation entry is listed twice", () => {
  const hrefs = STAFF_NAV_ITEMS.map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "a staff destination appears in two groups");
});

test("every entry names a permission that exists, or none at all", () => {
  for (const item of STAFF_NAV_ITEMS) {
    for (const permission of item.anyOf ?? []) {
      assert.ok(ALL.has(permission), `${item.href} requires "${permission}", which is not a real permission`);
    }
  }
});

test("every entry carries a label and a one-line description", () => {
  for (const item of STAFF_NAV_ITEMS) {
    assert.ok(item.label.trim().length > 0, `${item.href} has no label`);
    assert.ok(item.description.trim().length > 10, `${item.href} has no usable description`);
  }
});

/**
 * The failure this whole module exists to prevent: a settings page reachable
 * only by typing its URL.
 */
test("commerce settings is reachable from the navigation", () => {
  const item = STAFF_NAV_ITEMS.find((entry) => entry.href === "/staff/settings/commerce");
  assert.ok(item, "/staff/settings/commerce is not in the staff navigation");
  assert.ok(visibleStaffHrefs(ALL).includes("/staff/settings/commerce"));
  assert.ok(
    visibleStaffHrefs(new Set(["commerce.settings.view"])).includes("/staff/settings/commerce"),
    "holding only commerce.settings.view does not surface the page it grants"
  );
});

test("every staff section is reachable from the menu", () => {
  // Sub-pages (record details, create forms, printables) are reached from their
  // section, not from the menu. What must never happen is a *section* with no
  // way in — which is what /staff/settings/commerce was.
  const sections = [
    "/staff/orders",
    "/staff/fulfillment",
    "/staff/production",
    "/staff/catalog",
    "/staff/catalog/discounts",
    "/staff/inventory",
    "/staff/reconciliation",
    "/staff/settings",
    "/staff/settings/commerce",
    "/staff/appearance",
    "/staff/emails",
    "/staff/shops",
    "/staff/moderation/reports",
    "/staff/security",
    "/staff/users",
    "/staff/security/roles",
    "/staff/audit",
    "/staff/security/recycle-bin",
    "/staff/security/verified-perks",
    "/staff/info/todo",
    "/staff/info/pending",
    "/staff/info/updates",
    "/staff/info/analytics",
  ];
  const hrefs = new Set(STAFF_NAV_ITEMS.map((item) => item.href));
  for (const section of sections) {
    assert.ok(hrefs.has(section), `${section} exists but nothing in the staff menu links to it`);
  }
});

test("community is dormant: unlisted in the menu, but not deleted", () => {
  /*
   * Pass 14 took Community out of the customer product, and out of the staff
   * menu with it — curating a section customers cannot reach is work that leads
   * nowhere. This asserts the *pair* of facts, because either one alone is a
   * different and worse outcome: an entry with no page is a broken menu, and a
   * deleted page is destroyed history.
   */
  const hrefs = new Set(STAFF_NAV_ITEMS.map((item) => item.href));
  assert.ok(!hrefs.has("/staff/community"), "Community must not be in the staff menu");
  assert.ok(exists("src/app/staff/community/page.tsx"), "the page must still exist and still open by URL");
  assert.ok(exists("src/app/community/page.tsx"), "the public route must still exist");
  // The permission is untouched, so anyone who had it still has it.
  assert.ok(ALL.has("community.view"));
});

// ---------------------------------------------------------------------------
// Permission filtering
// ---------------------------------------------------------------------------

test("the menu never offers a page the viewer would be refused", () => {
  const hrefs = visibleStaffHrefs(new Set(["orders.view"]));
  assert.ok(hrefs.includes("/staff/orders"));
  assert.ok(!hrefs.includes("/staff/settings/commerce"));
  assert.ok(!hrefs.includes("/staff/security/roles"));
  assert.ok(!hrefs.includes("/staff/inventory"));
});

test("a group with nothing left in it is not rendered", () => {
  const groups = visibleStaffNav(new Set(["orders.view"]));
  assert.ok(groups.every((group) => group.items.length > 0));
  assert.ok(!groups.some((group) => group.id === "settings"));
});

test("somebody with no staff permission at all gets no menu", () => {
  assert.deepEqual(visibleStaffNav(new Set()), []);
  assert.equal(canUseStaffArea(new Set()), false);
  assert.equal(canUseStaffArea(new Set(["community.create_thread"])), false);
});

test("the dashboard is not offered on its own to somebody who can do nothing else", () => {
  // A sidebar whose only row leads to a page that refuses you is worse than no
  // sidebar; the dashboard has no permission of its own, so this is the guard.
  assert.deepEqual(visibleStaffHrefs(new Set(["community.create_thread"])), []);
});

test("the staff-area permission list is derived, not hand-maintained", () => {
  const declared = new Set(STAFF_NAV_ITEMS.flatMap((item) => item.anyOf ?? []));
  assert.deepEqual([...STAFF_AREA_PERMISSIONS].sort(), [...declared].sort());
});

test("an admin sees every group", () => {
  assert.equal(visibleStaffNav(ALL).length, STAFF_NAV.length);
});

// ---------------------------------------------------------------------------
// Active state — longest prefix wins
// ---------------------------------------------------------------------------

test("the dashboard is active only on /staff itself", () => {
  assert.equal(activeStaffNavItem("/staff")?.item.href, "/staff");
  assert.notEqual(activeStaffNavItem("/staff/orders")?.item.href, "/staff");
  assert.notEqual(activeStaffNavItem("/staff/settings/commerce")?.item.href, "/staff");
});

test("a nested route lights the most specific entry, not its parent", () => {
  assert.equal(activeStaffNavItem("/staff/catalog/discounts")?.item.href, "/staff/catalog/discounts");
  assert.equal(activeStaffNavItem("/staff/settings/commerce")?.item.href, "/staff/settings/commerce");
  assert.equal(activeStaffNavItem("/staff/security/roles")?.item.href, "/staff/security/roles");
  assert.equal(
    activeStaffNavItem("/staff/security/verified-perks")?.item.href,
    "/staff/security/verified-perks"
  );
});

test("the audit log is a top-level destination, and its old path still resolves", () => {
  // The audit log moved out of Security in the audit pass. It has its own
  // entry, and `/staff/security/audit` is a redirect page kept for bookmarks —
  // which has no menu entry of its own and so lights the Security section.
  assert.equal(activeStaffNavItem("/staff/audit")?.item.href, "/staff/audit");
  assert.equal(activeStaffNavItem("/staff/security/audit")?.item.href, "/staff/security");
});

test("a route with no entry of its own lights its section", () => {
  assert.equal(activeStaffNavItem("/staff/orders/abc-123")?.item.href, "/staff/orders");
  assert.equal(activeStaffNavItem("/staff/catalog/unknown-thing")?.item.href, "/staff/catalog");
  assert.equal(activeStaffNavItem("/staff/production/42/print")?.item.href, "/staff/production");
  assert.equal(activeStaffNavItem("/staff/inventory/p1")?.item.href, "/staff/inventory");
});

test("a sibling path that merely starts with the same characters is not a match", () => {
  // `/staff/ordersomething` must not light Orders. This is why matching is
  // `=== href || startsWith(href + "/")` rather than a bare `startsWith`.
  assert.notEqual(activeStaffNavItem("/staff/ordersomething")?.item.href, "/staff/orders");
});

test("exactly one entry is ever active", () => {
  for (const path of [
    "/staff",
    "/staff/orders",
    "/staff/orders/x",
    "/staff/catalog",
    "/staff/catalog/discounts",
    "/staff/settings",
    "/staff/settings/commerce",
    "/staff/security/users",
    "/staff/fulfillment",
    "/staff/reconciliation",
  ]) {
    const active = STAFF_NAV_ITEMS.filter((item) => isStaffNavItemActive(item, path));
    assert.equal(active.length, 1, `${path} lit ${active.length} entries`);
  }
});

test("the legacy redirect routes light their destination", () => {
  // Both former user routes now forward to /staff/users, so both must light the
  // one entry that owns it. `/staff/security/users` joined this list when user
  // management moved; a redirect whose menu entry stays dark tells a staff
  // member they have navigated out of the section they are still in.
  assert.equal(activeStaffNavItem("/staff/info/users")?.item.href, "/staff/users");
  assert.equal(activeStaffNavItem("/staff/security/users")?.item.href, "/staff/users");
  assert.equal(activeStaffNavItem("/staff/moderation")?.item.href, "/staff/moderation/reports");
});

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

test("the dashboard has no trail of its own", () => {
  assert.deepEqual(staffBreadcrumbs("/staff"), [{ href: "/staff", label: "Staff", current: true }]);
});

test("a section page reads Staff / group / page", () => {
  const crumbs = staffBreadcrumbs("/staff/settings/commerce");
  assert.deepEqual(
    crumbs.map((crumb) => crumb.label),
    ["Staff", "Settings", "Commerce"]
  );
  assert.equal(crumbs[crumbs.length - 1].current, true);
});

test("the group crumb is not a link", () => {
  // Groups are headings. The old context bar linked one to the first page
  // inside it, which navigated somewhere the reader had not asked to go.
  assert.equal(staffBreadcrumbs("/staff/catalog/discounts")[1].href, "");
});

test("a group whose name repeats its only item contributes no crumb", () => {
  /*
   * `Staff › Orders › Orders › Order` was the trail before this pass. Orders,
   * Production and Fulfillment are now one-item groups whose label *is* the
   * destination's label, so the group crumb would say the same word twice in a
   * row and teach the reader that a level of the hierarchy means nothing.
   */
  assert.deepEqual(
    staffBreadcrumbs("/staff/orders/abc").map((crumb) => crumb.label),
    ["Staff", "Orders", "Order"]
  );
  assert.deepEqual(
    staffBreadcrumbs("/staff/catalog/discounts").map((crumb) => crumb.label),
    ["Staff", "Store", "Discounts"]
  );
});

test("a known leaf gets its own crumb and an unknown one does not", () => {
  assert.deepEqual(
    staffBreadcrumbs("/staff/orders/abc").map((crumb) => crumb.label),
    ["Staff", "Orders", "Order"]
  );
  assert.deepEqual(
    staffBreadcrumbs("/staff/orders/new").map((crumb) => crumb.label),
    ["Staff", "Orders", "New proposal"]
  );
  // Nothing is invented for a path with no known shape: the trail stops at the
  // section rather than ending in a slug.
  const unknown = staffBreadcrumbs("/staff/catalog/something/deep");
  assert.deepEqual(
    unknown.map((crumb) => crumb.label),
    ["Staff", "Store", "Products"]
  );
  assert.equal(unknown[unknown.length - 1].current, true);
});

test("exactly one crumb is marked current", () => {
  for (const path of [
    "/staff",
    "/staff/orders",
    "/staff/orders/abc",
    "/staff/settings/commerce",
    "/staff/inventory/p1",
  ]) {
    assert.equal(staffBreadcrumbs(path).filter((crumb) => crumb.current).length, 1, path);
  }
});

// ---------------------------------------------------------------------------
// One source of truth
// ---------------------------------------------------------------------------

test("no staff chrome hard-codes its own route list", () => {
  for (const path of [
    "src/components/staff/StaffNav.tsx",
    "src/components/staff/StaffMobileNav.tsx",
    "src/components/staff/StaffBreadcrumbs.tsx",
    "src/app/staff/settings/page.tsx",
  ]) {
    const source = read(path);
    const hardCoded = source.match(/href=["']\/staff[^"'{]*["']/g) ?? [];
    assert.deepEqual(hardCoded, [], `${path} hard-codes ${hardCoded.join(", ")} instead of reading staffNavigation`);
    assert.match(source, /staffNavigation/, `${path} does not read the navigation module`);
  }
});

test("the desktop sidebar and the mobile drawer read the same definition", () => {
  for (const path of ["src/components/staff/StaffNav.tsx", "src/components/staff/StaffMobileNav.tsx"]) {
    const source = read(path);
    assert.match(source, /visibleStaffNav/);
    assert.match(source, /isStaffNavItemActive/);
  }
});

test("the settings index derives its cards from the Settings group", () => {
  const settings = read("src/app/staff/settings/page.tsx");
  const navigation = read("src/lib/staffNavigation.ts");
  // The derivation moved into `staffSettingsSections`, which the page calls —
  // still one source, now also responsible for the four named blocks the flat
  // grid of seven cards lacked.
  assert.match(settings, /staffSettingsSections/);
  /*
   * The index reads `settingsSection` across the **whole** navigation, not just
   * the Settings group.
   *
   * This pass folded Site access & safety, Verified perks, the Recycle bin, the
   * Audit log and People & accounts into the "More tools" disclosure. Deriving
   * the settings index from group membership would have silently dropped all
   * five off `/staff/settings` — the exact drift that once left
   * `/staff/settings/commerce` reachable only by typing its URL.
   */
  assert.match(navigation, /item\.settingsSection/);
  // The overview must not link to itself.
  assert.match(navigation, /item\.href !== "\/staff\/settings"/);
});

test("every settings destination reaches the index wherever it sits in the sidebar", () => {
  const sections = staffSettingsSections(ALL);
  const listed = sections.flatMap((section) => section.items.map((item) => item.href));
  for (const href of [
    "/staff/settings/commerce",
    "/staff/appearance",
    "/staff/security/roles",
    "/staff/security",
    "/staff/security/verified-perks",
    "/staff/security/recycle-bin",
    "/staff/audit",
    "/staff/users",
  ]) {
    assert.ok(listed.includes(href), `${href} is not reachable from the settings index`);
  }
  // No duplicates: an item filed in two blocks would be two answers to one
  // question.
  assert.equal(new Set(listed).size, listed.length);
});

test("every settings destination is filed under a named block", () => {
  const settingsGroup = STAFF_NAV.find((group) => group.id === "settings");
  assert.ok(settingsGroup, "the Settings group must exist");
  for (const item of settingsGroup.items) {
    if (item.href === "/staff/settings") continue;
    assert.ok(
      item.settingsSection,
      `${item.label} has no settings section, so the index would silently drop it`
    );
  }
});

test("every icon key used by the navigation is mapped to a real icon", () => {
  const icons = read("src/components/staff/StaffNavIcon.tsx");
  for (const item of STAFF_NAV_ITEMS) {
    assert.match(icons, new RegExp(`\\b${item.icon}:\\s*fa`), `icon "${item.icon}" has no mapping`);
  }
});

// ---------------------------------------------------------------------------
// The drawer is a real dialog
// ---------------------------------------------------------------------------

test("the mobile drawer is a dialog, portalled, focus-trapped and dismissible", () => {
  const drawer = read("src/components/staff/StaffMobileNav.tsx");
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-labelledby="staff-drawer-title"/);
  // Portalled onto the body: a transformed ancestor becomes the containing
  // block for a fixed descendant, which is what rendered the customer drawer
  // 60px tall in pass 6.
  assert.match(drawer, /createPortal\(/);
  assert.match(drawer, /document\.body/);
  assert.match(drawer, /event\.key === "Escape"/);
  assert.match(drawer, /triggerRef\.current\?\.focus\(\)/);
  assert.match(drawer, /event\.key !== "Tab"/);
  assert.match(drawer, /body\.style\.overflow = "hidden"/);
  assert.match(drawer, /window\.scrollTo\(0, scrollY\)/);
});

test("the drawer is not a second copy of the sidebar rendered inline", () => {
  // The shell moved into a client component, because the collapsed rail's width
  // is a grid-column decision the sidebar could not reach. The rule it enforces
  // is unchanged and asserted at its new home.
  const shell = stripComments(read("src/components/staff/StaffShell.tsx"));
  // The old layout rendered the sidebar twice — once in the rail and once
  // inside a disclosure — so every link existed twice in the accessibility tree.
  assert.equal((shell.match(/<StaffNav\b/g) ?? []).length, 1);
  assert.match(shell, /<StaffMobileNav \/>/);
  assert.doesNotMatch(shell, /<details/);
  // The layout must not grow a second one back.
  assert.doesNotMatch(stripComments(read("src/app/staff/layout.tsx")), /<StaffNav\b/);
});

test("the staff chrome is dropped on paper", () => {
  assert.match(read("src/app/globals.css"), /@media print[\s\S]*\.staff-nav/);
  assert.match(read("src/app/staff/layout.tsx"), /print-hidden/);
});

test("sidebar preferences cannot cause a hydration mismatch", () => {
  // Reading localStorage while rendering makes the server markup and the first
  // client paint disagree, and this project already carries one hydration
  // mismatch. `useSyncExternalStore` serves the default for SSR and hydration
  // and switches afterwards, which is the property being asserted; the sidebar
  // must not reach for storage itself.
  const sidebar = read("src/components/staff/StaffNav.tsx");
  assert.match(sidebar, /useStoredPreference/);
  // Comments stripped: the file explains which preferences are stored, and an
  // assertion that a call is absent must read the code, not the prose.
  assert.doesNotMatch(stripComments(sidebar), /localStorage/);

  const hook = read("src/lib/hooks/useStoredPreference.ts");
  assert.match(hook, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/);
  assert.match(hook, /const getServerSnapshot = useCallback\(\(\) => fallback/);
});

test("no staff chrome writes state from inside an effect", () => {
  // A `setState` in an effect body is a cascading render on every mount, and is
  // what `react-hooks/set-state-in-effect` objects to. The drawer derives its
  // open state from the path it was opened on instead.
  const drawer = read("src/components/staff/StaffMobileNav.tsx");
  assert.match(drawer, /const open = openedOn === pathname/);
  assert.doesNotMatch(drawer, /useEffect\(\(\) => \{\s*set[A-Z]/);

  const sidebar = read("src/components/staff/StaffNav.tsx");
  assert.doesNotMatch(sidebar, /useEffect/);
});

test("a collapsed group containing the current page is forced open", () => {
  assert.match(read("src/components/staff/StaffNav.tsx"), /const collapsed = !containsActive &&/);
});

test("the compact rail does not unfold the secondary group", () => {
  /*
   * Primary groups are forced open in the compact rail — there is nothing to
   * collapse when every label is already hidden. "More tools" is not, because
   * eleven extra icons under the four that matter is the wall of
   * undifferentiated targets this pass removed from the expanded sidebar.
   */
  assert.match(
    read("src/components/staff/StaffNav.tsx"),
    /group\.secondary \? !flipped : !isCompact && flipped/
  );
});

test("reduced motion is honoured by the staff chrome", () => {
  assert.match(read("src/app/globals.css"), /prefers-reduced-motion: reduce\)[\s\S]{0,400}\.staff-drawer-panel/);
});

// ---------------------------------------------------------------------------
// Unchanged from before this pass
// ---------------------------------------------------------------------------

test("monitoring test is staff-only on both the page and API", () => {
  /*
   * Re-pointed from `/staff/settings` to `/staff/integrations`.
   *
   * The panel moved because it is a diagnostic, not a setting — but the
   * property this test exists for is unchanged and still asserted: the same
   * `security.view` gate on the page, and the same gate plus real Sentry
   * plumbing on the API behind it. The move granted nobody new access.
   */
  const host = read("src/app/staff/integrations/page.tsx");
  const route = read("src/app/api/staff/monitoring/test/route.ts");
  assert.match(host, /permissions\.has\("security\.view"\)/);
  assert.doesNotMatch(
    read("src/app/staff/settings/page.tsx"),
    /SentryTestPanel/,
    "the settings index must not host diagnostics"
  );
  assert.match(route, /requirePermission\(request, "security\.view"\)/);
  assert.match(route, /Sentry\.captureException/);
  assert.match(route, /Sentry\.flush/);
});

// ---------------------------------------------------------------------------
// Pass 12 — the communications and readiness destinations
// ---------------------------------------------------------------------------

test("the operational surfaces are reachable from the navigation", () => {
  /*
   * `/staff/settings/commerce` shipped in pass 8 reachable only by typing the
   * URL, because it was in neither of the two navigation lists that existed
   * then. These three are the pass-12 equivalents, so they are asserted by name
   * rather than left to the generic href check.
   */
  const hrefs = STAFF_NAV_ITEMS.map((item) => item.href);
  for (const href of ["/staff/integrations", "/staff/launch-readiness"]) {
    assert.ok(hrefs.includes(href), `${href} is not reachable from the staff navigation`);
  }
});

test("the delivery centre is owned by the email entry rather than listed twice", () => {
  // `/staff/emails` owns `/staff/emails/...` by prefix. A second entry would
  // light two rows for one page.
  const hrefs = STAFF_NAV_ITEMS.map((item) => item.href);
  assert.ok(!hrefs.includes("/staff/emails/deliveries"));
  assert.equal(activeStaffNavItem("/staff/emails/deliveries")?.item.href, "/staff/emails");
  assert.equal(activeStaffNavItem("/staff/launch-readiness/discrepancies")?.item.href, "/staff/launch-readiness");
});

test("the new entries are permission-gated, and a holder of none sees none of them", () => {
  const integrations = STAFF_NAV_ITEMS.find((item) => item.href === "/staff/integrations");
  const readiness = STAFF_NAV_ITEMS.find((item) => item.href === "/staff/launch-readiness");
  assert.deepEqual([...(integrations?.anyOf ?? [])], ["operations.health.view"]);
  assert.deepEqual([...(readiness?.anyOf ?? [])], ["launch.readiness.view", "operations.health.view"]);

  const ordersOnly = new Set(["orders.view"]);
  const visible = visibleStaffHrefs(ordersOnly);
  assert.ok(!visible.includes("/staff/integrations"));
  assert.ok(!visible.includes("/staff/launch-readiness"));

  // And a holder of exactly the new permissions does see them.
  const opsOnly = new Set(["operations.health.view", "launch.readiness.view"]);
  const opsVisible = visibleStaffHrefs(opsOnly);
  assert.ok(opsVisible.includes("/staff/integrations"));
  assert.ok(opsVisible.includes("/staff/launch-readiness"));
});

test("a holder of emails.view alone can reach the email section", () => {
  // Read access to delivery history is a real reason to open `/staff/emails`,
  // so the entry admits it rather than requiring the template-editing key.
  const visible = visibleStaffHrefs(new Set(["emails.view"]));
  assert.ok(visible.includes("/staff/emails"));
});

test("the new breadcrumb leaves are labelled rather than guessed", () => {
  const discrepancies = staffBreadcrumbs("/staff/launch-readiness/discrepancies");
  assert.equal(discrepancies[discrepancies.length - 1].label, "Payment discrepancies");
});

// ---------------------------------------------------------------------------
// The size of the menu
// ---------------------------------------------------------------------------

test("the always-visible menu is at most 17 destinations", () => {
  /*
   * Pass 15 set this at 16, down from 27 rows in 8 expanded groups all weighted
   * the same. The ceiling is here rather than in a document because the failure
   * mode is not a redesign — it is the next pass adding "just one more" row,
   * five times.
   *
   * **It moved to 17 in the support pass, and that is the whole point of the
   * assertion: raising it is a decision somebody had to make in a diff.** The
   * reasoning, so the next pass has to beat it rather than repeat it: Support is
   * a queue with people waiting in it, worked every day, and it is the only
   * surface where a customer is waiting on a *reply* rather than on work. That
   * is the same test Orders, Production and Fulfillment pass. Nothing else was
   * demoted because nothing else stopped being daily.
   *
   * Adding a destination is still fine. Adding a *primary* destination still
   * means arguing for it here.
   */
  assert.ok(
    PRIMARY_STAFF_NAV_ITEMS.length <= 17,
    `${PRIMARY_STAFF_NAV_ITEMS.length} primary destinations; the ceiling is 17`
  );
});

test("nothing was deleted when the menu shrank", () => {
  // Every route that had a menu entry before this pass still has one. The
  // difference is which of them a staff member has to read past every morning.
  const all = new Set(visibleStaffHrefs(ALL));
  for (const href of [
    "/staff/info/analytics",
    "/staff/audit",
    // Renamed, not removed: user management moved from /staff/security/users to
    // /staff/users, and the old route still opens as a redirect.
    "/staff/users",
    "/staff/moderation/reports",
    "/staff/security",
    "/staff/security/verified-perks",
    "/staff/security/recycle-bin",
    "/staff/info/todo",
    "/staff/info/pending",
    "/staff/info/updates",
    "/staff/shops",
  ]) {
    assert.ok(all.has(href), `${href} lost its menu entry`);
  }
});

test("exactly one group is secondary, and the primary groups are the task list", () => {
  const secondary = STAFF_NAV.filter((group) => group.secondary);
  assert.equal(secondary.length, 1);
  assert.equal(secondary[0].id, "more");
  assert.deepEqual(
    STAFF_NAV.filter((group) => !group.secondary).map((group) => group.id),
    // `support` sits directly after `orders`: the order of this list is the
    // order work travels, and a customer's question arrives before, during and
    // after everything else the shop does.
    ["dashboard", "orders", "support", "production", "fulfillment", "store", "business", "settings"]
  );
});

test("primaryStaffNav never returns the secondary group", () => {
  for (const group of primaryStaffNav(ALL)) assert.notEqual(group.id, "more");
});
