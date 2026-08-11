import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PERMISSIONS, PERMISSION_META, type PermissionKey } from "../src/lib/permissions.ts";
import {
  effectivePermissions,
  OVERRIDE_RULE,
  PERMISSION_GROUPS,
  PERMISSION_SOURCES,
  PERMISSION_SOURCE_MARKS,
  permissionGroup,
  permissionGroupViews,
  permissionLabel,
  permissionRow,
  permissionsInGroup,
  roleChangeImpact,
} from "../src/lib/staff/permissionGroups.ts";
import {
  RESTRICTION_DURATIONS,
  RESTRICTION_KINDS,
  RESTRICTION_KIND_LABELS,
  RESTRICTION_KIND_MEANING,
  STATUS_ACTION_COPY,
  STATUS_ACTIONS,
} from "../src/lib/staff/userAccess.ts";
import {
  ACCOUNT_STATUS_FILTERS,
  ACCOUNT_STATUSES,
  activeFilterChips,
  emptyUserFilters,
  parseUserFilters,
  segmentFilters,
  statusFilterValues,
  userFiltersToQuery,
  userSegment,
  USER_SEGMENTS,
  type UserFilters,
} from "../src/lib/staff/userDirectory.ts";

/**
 * The user-management UX overhaul — the rules the redesign rests on.
 *
 * The security properties live in `user-management.test.ts` and are untouched.
 * This file holds the *architecture*: that every permission has exactly one
 * home, that the screen cannot claim a permission was denied when the schema
 * has no way to deny one, that a role change states what it costs, and that a
 * failed request is never rendered as a healthy empty state.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const readCode = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DIRECTORY = readCode("src/app/staff/users/page.tsx");
const WORKSPACE = readCode("src/app/staff/users/[id]/page.tsx");
const ACCESS_TAB = readCode("src/components/staff/UserAccessTab.tsx");
const OVERVIEW = readCode("src/components/staff/UserOverviewTab.tsx");
const MATRIX = readCode("src/components/staff/UserPermissionOverrides.tsx");
const TABS = readCode("src/components/staff/UserWorkspaceTabs.tsx");
const CSS = read("src/app/globals.css");

// ---------------------------------------------------------------------------
// Permission grouping: total, disjoint, and readable
// ---------------------------------------------------------------------------

test("every permission has exactly one group", () => {
  const homeless = (PERMISSIONS as readonly string[]).filter((key) => permissionGroup(key) === null);
  assert.deepEqual(
    homeless,
    [],
    "a permission with no group disappears from the Access tab entirely — add a prefix rule"
  );

  // Disjoint: the union of the groups is the whole list, counted.
  const grouped = PERMISSION_GROUPS.flatMap((group) => permissionsInGroup(group.id));
  assert.equal(grouped.length, PERMISSIONS.length, "a permission is in two groups, or in none");
  assert.equal(new Set(grouped).size, PERMISSIONS.length, "a permission appears in more than one group");
});

test("no group is empty, and none is a dumping ground", () => {
  for (const group of PERMISSION_GROUPS) {
    const rows = permissionsInGroup(group.id);
    assert.ok(rows.length > 0, `the "${group.label}" group renders as an empty accordion`);
  }
  assert.ok(
    !PERMISSION_GROUPS.some((group) => /other|misc/i.test(group.label)),
    "an 'Other' group is where permissions go to be missed"
  );
});

test("the matrix shows sentences, not permission keys", () => {
  for (const key of PERMISSIONS as readonly PermissionKey[]) {
    const label = permissionLabel(key);
    assert.notEqual(label, key, `${key} has no human label in PERMISSION_META`);
    assert.ok(!/\./.test(label), `the label for ${key} still reads like a key: ${label}`);
  }
  // The raw key stays reachable for whoever is debugging a grant.
  assert.match(MATRIX, /showKeys/, "there is no way to see the underlying key at all");
  assert.match(MATRIX, /Advanced/, "the key toggle is not labelled Advanced");
});

test("permission group labels come from one table, and the tab renders that table", () => {
  assert.match(MATRIX, /permissionGroupViews/, "the matrix must not group permissions itself");
  for (const group of ["Commerce", "Production", "Support", "Access & security", "Audit", "Automation"]) {
    assert.ok(
      PERMISSION_GROUPS.some((candidate) => candidate.label === group),
      `the brief names a "${group}" group and there is none`
    );
  }
});

// ---------------------------------------------------------------------------
// Where a permission comes from
// ---------------------------------------------------------------------------

test("a permission resolves to role, override, or nothing — and never to denied", () => {
  assert.deepEqual([...PERMISSION_SOURCES], ["role", "override", "none"]);
  assert.ok(
    !(PERMISSION_SOURCES as readonly string[]).includes("denied"),
    "user_permissions is additive; a denied state would be a control that does nothing"
  );

  const rolePermissions = new Set(["orders.view"]);
  const overrides = new Set(["refunds.issue", "orders.view"]);

  assert.equal(permissionRow({ key: "orders.view", rolePermissions, overrides }).source, "role");
  assert.equal(permissionRow({ key: "refunds.issue", rolePermissions, overrides }).source, "override");
  assert.equal(permissionRow({ key: "orders.manage", rolePermissions, overrides }).source, "none");
});

test("an override duplicating the role is reported as coming from the role", () => {
  // Otherwise somebody 'cleans up' a redundant grant believing it is load-bearing.
  const row = permissionRow({
    key: "orders.view",
    rolePermissions: new Set(["orders.view"]),
    overrides: new Set(["orders.view"]),
  });
  assert.equal(row.source, "role");
  assert.equal(row.fromRole, true);
  assert.equal(row.overridden, true);
});

test("the three sources differ by shape, not only by colour", () => {
  const marks = Object.values(PERMISSION_SOURCE_MARKS);
  assert.equal(new Set(marks).size, marks.length, "two sources share a mark");
  assert.match(CSS, /\.staff-perm-row\[data-source="role"\]/, "the source is not expressed in the markup");
  assert.match(MATRIX, /PERMISSION_SOURCE_LABELS/, "the source must also be spelled out in words");
});

test("the override rule is stated on screen", () => {
  assert.match(OVERRIDE_RULE, /only add/i);
  assert.match(MATRIX, /OVERRIDE_RULE/, "the rule is defined and never rendered");
});

test("a permission the role grants offers no checkbox", () => {
  // Unticking it removes nothing. A control that cannot do what it looks like
  // it does is worse than no control.
  assert.match(MATRIX, /const editable = canGrant && !row\.fromRole/);
});

test("effective permissions are the union, and the group counts follow it", () => {
  const held = effectivePermissions({
    rolePermissions: new Set(["support.view"]),
    overrides: new Set(["support.assign"]),
  });
  assert.deepEqual([...held].sort(), ["support.assign", "support.view"]);

  const views = permissionGroupViews({
    rolePermissions: new Set(["support.view"]),
    overrides: new Set(["support.assign"]),
  });
  const support = views.find((group) => group.id === "support");
  assert.ok(support);
  assert.equal(support.heldCount, 2);
  assert.equal(support.overrideCount, 1);
});

// ---------------------------------------------------------------------------
// Role changes
// ---------------------------------------------------------------------------

test("a role change names the areas lost, gained and kept", () => {
  const impact = roleChangeImpact({
    currentRolePermissions: new Set(["catalog.manage", "orders.view", "support.view", "users.view"]),
    nextRolePermissions: new Set(["support.view", "support.reply"]),
    overrides: new Set(),
  });

  assert.ok(impact.lost.includes("Commerce"), "losing every commerce permission must read as losing Commerce");
  assert.ok(impact.lost.includes("People"), "losing user management must be named");
  assert.ok(impact.retained.includes("Support"), "what is kept must be stated too");
  assert.deepEqual(impact.gained, []);
});

test("an area kept only through an override is not reported as lost", () => {
  // Overrides survive a role change — the grant rows are not touched by it.
  const impact = roleChangeImpact({
    currentRolePermissions: new Set(["refunds.issue"]),
    nextRolePermissions: new Set(),
    overrides: new Set(["orders.view"]),
  });
  assert.ok(!impact.lost.includes("Commerce"), "the override still holds Commerce open");
  assert.ok(impact.retained.includes("Commerce"));
});

test("losing one permission of nine is not losing the area", () => {
  const impact = roleChangeImpact({
    currentRolePermissions: new Set(["orders.view", "orders.manage"]),
    nextRolePermissions: new Set(["orders.view"]),
    overrides: new Set(),
  });
  assert.deepEqual(impact.lost, [], "a partial reduction must not be announced as losing the whole area");
  assert.ok(impact.lostKeys.includes("orders.manage"), "the exact key is still available for Advanced");
});

test("the role change is a confirmation, and it carries the impact", () => {
  assert.match(ACCESS_TAB, /ConsequentialAction/, "a role change must not be a bare button");
  assert.match(ACCESS_TAB, /roleChangeImpact/, "the dialog must state what changes");
  assert.match(ACCESS_TAB, /expectedRole: user\.roleKey/, "stale-state protection must survive the redesign");
});

test("the role panel still explains the rules it cannot bypass", () => {
  // Whitespace-tolerant: this is JSX prose and it wraps wherever the formatter
  // decides, which is not something a test should be able to break.
  const prose = ACCESS_TAB.replace(/\s+/g, " ");
  for (const rule of ["need a second admin", "last remaining admin cannot be demoted"]) {
    assert.ok(prose.includes(rule), `the panel never mentions: ${rule}`);
  }
  assert.match(
    ACCESS_TAB,
    /viewer\.canAssignRole \?/,
    "the control must be gated on the server's decision, not on a client guess"
  );
  assert.match(ACCESS_TAB, /outranksViewer/, "a refusal above your own rank must say so");
});

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

test("every status action has copy naming both the effect and what survives", () => {
  for (const action of STATUS_ACTIONS) {
    const copy = STATUS_ACTION_COPY[action];
    assert.ok(copy, `${action} has no copy`);
    assert.ok(copy.effect.length > 10, `${action} does not say what happens`);
    assert.ok(copy.preserved.length > 10, `${action} does not say what keeps working`);
  }
  // The one thing a shop must never imply it is doing.
  assert.match(STATUS_ACTION_COPY.suspend.preserved, /paid orders/i);
});

test("every restriction area explains what it withholds and what it does not", () => {
  for (const kind of RESTRICTION_KINDS) {
    assert.ok(RESTRICTION_KIND_LABELS[kind], `${kind} has no label`);
    const meaning = RESTRICTION_KIND_MEANING[kind];
    assert.ok(meaning && meaning.length > 20, `${kind} has no explanation`);
    assert.match(meaning, /unaffected|still|can /i, `${kind} never says what remains available`);
  }
});

test("a restriction can be given a length, and the UI sends it", () => {
  /*
   * The route has accepted `durationHours` since the table was created and the
   * old panel never sent it, so every restriction applied from that screen was
   * permanent whether anybody meant it or not.
   */
  assert.ok(RESTRICTION_DURATIONS.some((option) => option.hours === null), "there must be an indefinite option");
  assert.ok(RESTRICTION_DURATIONS.some((option) => option.hours === 24), "and at least one bounded one");
  assert.match(ACCESS_TAB, /durationHours/, "the panel does not offer a duration");
  assert.match(ACCESS_TAB, /action: "restrict", kind, reason: text, durationHours/, "the duration is not sent");
});

test("a status change is a confirmation with a required reason and a stale check", () => {
  assert.match(ACCESS_TAB, /MIN_STATUS_REASON_LENGTH/, "the minimum reason length is not enforced in the UI");
  assert.match(ACCESS_TAB, /required: true/, "the reason is optional in the dialog");
  assert.match(ACCESS_TAB, /expectedStatus: status\.value/, "the stale-status guard is not sent");
  assert.match(ACCESS_TAB, /viewer\.isSelf/, "the self-edit refusal must still be shown");
});

test("restore and lift are offered only when there is something to undo", () => {
  assert.match(ACCESS_TAB, /status\.value === "suspended" \? \(/, "Restore access must not appear on an active account");
  assert.match(ACCESS_TAB, /activeKinds\.has\(kind\)/, "Lift must not appear for an area that is not restricted");
});

test("the three backend restriction kinds are preserved, not collapsed", () => {
  assert.deepEqual([...RESTRICTION_KINDS], ["site", "community", "dm"]);
  assert.match(ACCESS_TAB, /RESTRICTION_KINDS\.map/, "the panel must still be able to reach all three");
});

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

test("the four segments cover the questions staff actually ask", () => {
  assert.deepEqual([...USER_SEGMENTS], ["all", "customers", "staff", "limited"]);
  assert.deepEqual(segmentFilters("all"), { kind: null, status: null });
  assert.deepEqual(segmentFilters("customers"), { kind: "customer", status: null });
  assert.deepEqual(segmentFilters("staff"), { kind: "staff", status: null });
  assert.deepEqual(segmentFilters("limited"), { kind: null, status: "limited" });
});

test("a segment round-trips through the filters it stands for", () => {
  for (const segment of USER_SEGMENTS) {
    assert.equal(userSegment(segmentFilters(segment)), segment, `${segment} does not read back as itself`);
  }
});

test("a filter set no segment describes lights none of them", () => {
  // Highlighting "All" on a list filtered to suspended staff would tell the
  // reader they are seeing everybody when they are not.
  assert.equal(userSegment({ kind: "staff", status: "suspended" }), null);
});

test("`limited` is a filter value, never a status an account holds", () => {
  assert.ok(!(ACCOUNT_STATUSES as readonly string[]).includes("limited"));
  assert.ok((ACCOUNT_STATUS_FILTERS as readonly string[]).includes("limited"));
  assert.deepEqual(statusFilterValues("limited"), ["restricted", "suspended"]);
  assert.deepEqual(statusFilterValues("active"), ["active"]);
});

test("the route widens `limited` and matches everything else exactly", () => {
  const route = readCode("src/app/api/staff/users/route.ts");
  assert.match(route, /statusFilterValues\(filters\.status\)/, "the route must use the shared widening");
  assert.match(route, /wanted\.length === 1 \? query\.eq\("account_status", wanted\[0\]\) : query\.in\(/);
});

test("each active filter is removable on its own", () => {
  const filters: UserFilters = {
    ...emptyUserFilters(),
    search: "ethan",
    provider: "google",
    orders: "has_orders",
  };
  const chips = activeFilterChips(filters);
  assert.equal(chips.length, 3);
  assert.deepEqual(
    chips.map((chip) => chip.key).sort(),
    ["orders", "provider", "search"]
  );
  assert.match(DIRECTORY, /Remove \$\{chip\.label\} filter/, "the remove control has no accessible name");
});

test("the segment's own filters are not repeated as chips", () => {
  const staffOnly: UserFilters = { ...emptyUserFilters(), kind: "staff" };
  assert.deepEqual(activeFilterChips(staffOnly), [], "the segmented control already says this");

  // But a combination no segment describes is stated, or it would be invisible.
  const odd: UserFilters = { ...emptyUserFilters(), kind: "staff", status: "suspended" };
  const keys = activeFilterChips(odd).map((chip) => chip.key);
  assert.ok(keys.includes("kind") && keys.includes("status"));
});

test("removing one filter keeps the others", () => {
  const filters: UserFilters = { ...emptyUserFilters(), search: "ethan", provider: "google", orders: "has_orders" };
  const blank = emptyUserFilters();
  const next = { ...filters, provider: blank.provider };
  const query = userFiltersToQuery(next);
  assert.ok(query.includes("q=ethan"), "the search was thrown away with the provider");
  assert.ok(query.includes("orders=has_orders"));
  assert.ok(!query.includes("provider="));
});

test("the directory row carries the eight facts and not the whole record", () => {
  for (const shown of ["UserAvatar", "roleName", "accountStatus", "netSpendCents", "orderCount", "lastSeenAt", "email"]) {
    assert.ok(DIRECTORY.includes(shown), `the row does not show ${shown}`);
  }
  for (const withheld of ["donationRank", "isVerified", "bio", "location", "roleRank"]) {
    assert.ok(!DIRECTORY.includes(withheld), `${withheld} belongs in the detail view, not on a directory row`);
  }
});

test("a row whose name is its address does not print the address twice", () => {
  assert.match(DIRECTORY, /label === user\.email \? "No name on record"/);
});

test("server-side paging and filtering were not traded for the redesign", () => {
  assert.match(DIRECTORY, /userFiltersToQuery\(filters\)/, "filters must still go to the server");
  assert.match(DIRECTORY, /page: filters\.page \+ 1/, "paging must still be server-side");
  assert.ok(
    !/\.filter\(\(user\)/.test(DIRECTORY),
    "the page must not filter the loaded page in the browser — that is the bug this route replaced"
  );
});

// ---------------------------------------------------------------------------
// The workspace header and Overview
// ---------------------------------------------------------------------------

test("the primary actions live in the header, not scattered across tabs", () => {
  const header = WORKSPACE.slice(WORKSPACE.indexOf("<PageHeader"), WORKSPACE.indexOf("<PageTabs"));
  for (const action of ["Latest order", "Add note", "Manage access", "All people"]) {
    assert.ok(header.includes(action), `"${action}" is not a header action`);
  }
});

test("the header states the numbers, and a count the viewer may not see is not zero", () => {
  const header = WORKSPACE.slice(WORKSPACE.indexOf("staff-metric-strip"), WORKSPACE.indexOf("<PageTabs"));
  for (const metric of ["Orders", "Spend", "Open", "Refunded", "Support"]) {
    assert.ok(header.includes(metric), `the metric strip does not carry ${metric}`);
  }
  assert.match(
    header,
    /openSupportCount === null \?/,
    "a support count the viewer cannot read must render as unknown, never as 0"
  );
});

test("the API sends null rather than zero for counts the viewer may not read", () => {
  const route = readCode("src/app/api/staff/users/[id]/route.ts");
  assert.match(route, /actor\.permissions\.has\("support\.view"\)\s*\?/, "the support count is not gated");
  assert.match(route, /Promise\.resolve\(\{ count: null \}\)/, "a withheld count must be null");
  assert.match(route, /mayReadNotes/, "the note preview is not gated");
});

test("Overview summarises and never repeats a whole tab", () => {
  assert.ok(!/OrdersPanel|SupportPanel|CommunicationsPanel/.test(OVERVIEW), "Overview must not mount another tab");
  assert.match(OVERVIEW, /recentNotes/, "the latest notes belong on the summary");
  assert.match(OVERVIEW, /RecentActivityList/, "the latest events belong on the summary");
  assert.match(OVERVIEW, /onOpenTab\("orders"\)/, "there must be a way through to the full list");
});

test("a staff account leads with access, a customer with commerce", () => {
  assert.match(OVERVIEW, /user\.isStaff \? summary : commerce/, "the two orders are not swapped by account kind");
  assert.match(OVERVIEW, /Staff summary|Customer summary/, "the heading does not change with the kind of account");
  assert.match(
    OVERVIEW,
    /No orders\. This is a staff account\./,
    "a staff account with no orders must say so rather than render ten zeroes"
  );
});

test("guest orders are still never claimed by the account", () => {
  assert.match(TABS, /Unclaimed guest orders with matching email/);
  assert.match(TABS, /NOT part of this account/);
  assert.match(OVERVIEW, /not part of this account and are excluded from every figure/);
});

// ---------------------------------------------------------------------------
// Errors, empties and the states in between
// ---------------------------------------------------------------------------

test("every panel keeps a refusal distinct from an empty list", () => {
  assert.match(TABS, /res\.status === 403 \? forbiddenMessage : "Could not load this\."/);
  for (const message of [
    "You do not have permission to view orders.",
    "You do not have permission to view the audit log.",
    "You do not have permission to read staff notes.",
    "You do not have permission to view email history.",
    "You do not have permission to view support conversations.",
  ]) {
    assert.ok(TABS.includes(message), `no distinct refusal message for: ${message}`);
  }
});

test("each tab has a named empty state rather than a blank panel", () => {
  for (const empty of [
    "This account has not placed an order.",
    "This account has not contacted support.",
    "No internal notes on this account.",
    "No recorded activity for this account.",
    "No email has been sent to this account.",
  ]) {
    assert.ok(TABS.includes(empty), `no empty state for: ${empty}`);
  }
});

test("the permission matrix says why it is empty rather than showing nothing", () => {
  // A viewer without `roles.view` must not be shown a matrix in which everybody
  // appears to hold nothing.
  assert.match(MATRIX, /rolePermissions === null/, "a withheld role definition is treated as an empty set");
  assert.match(MATRIX, /Not shown/, "and it never says so");
});

// ---------------------------------------------------------------------------
// Layout, and the two measurements that drove it
// ---------------------------------------------------------------------------

test("the directory list sizes its columns from its own box, not the viewport", () => {
  /*
   * The staff shell puts a 280px rail beside the content from 1024px up, so a
   * viewport breakpoint switched five columns on when the list had 667px and
   * produced a 75px row of wrapped words.
   */
  // `[^}]` already crosses newlines, so no dotAll flag is needed — and the
  // project's TS target predates it.
  assert.match(CSS, /\.staff-people \{[^}]*container-type: inline-size/);
  assert.match(CSS, /@container \(min-width: 760px\)[\s\S]{0,400}\.staff-person \{/);
});

test("the person workspace's tab strip wraps on a phone instead of scrolling out of sight", () => {
  assert.match(CSS, /\.ui-tabs-wrap \{ flex-wrap: wrap; overflow-x: visible; \}/);
  assert.match(WORKSPACE, /className="ui-tabs-wrap"/);
  // Opt-in, so the order workspace's eight tabs keep the scrolling strip.
  assert.ok(!/\.ui-tabs \{[^}]*flex-wrap: wrap/.test(CSS), "the wrap must not apply to every tab strip");
});

test("the filter disclosure is a real target and names what it controls", () => {
  assert.match(DIRECTORY, /aria-expanded=\{showFilters\}/);
  assert.match(DIRECTORY, /aria-controls=\{filterPanelId\}/);
  assert.ok(
    !/className="ui-chip"\s+aria-expanded=\{showFilters\}/.test(DIRECTORY),
    "`.ui-chip` renders as a 24px target on a phone; the only route to six filters must not be one"
  );
});

test("the segmented control is a group of pressed buttons, not a fake tablist", () => {
  assert.match(DIRECTORY, /role="group" aria-label="Show"/);
  assert.match(DIRECTORY, /aria-pressed=\{segment === id\}/);
});

// ---------------------------------------------------------------------------
// Nothing was quietly dropped
// ---------------------------------------------------------------------------

test("the old routes still redirect to the directory", () => {
  for (const path of ["src/app/staff/security/users/page.tsx", "src/app/staff/info/users/page.tsx"]) {
    assert.match(read(path), /redirect\("\/staff\/users"\)/, `${path} does not forward to /staff/users`);
  }
});

test("the sidebar names it People and still owns the legacy paths", () => {
  const nav = read("src/lib/staffNavigation.ts");
  const start = nav.indexOf('href: "/staff/users"');
  const entry = nav.slice(start, start + 1400);
  assert.match(entry, /label: "People"/);
  assert.match(entry, /alsoOwns: \["\/staff\/info\/users", "\/staff\/security\/users"\]/);
});

test("a person page gets a breadcrumb leaf that does not move under the reader", () => {
  const nav = read("src/lib/staffNavigation.ts");
  assert.match(nav, /\{ test: \/\^\\\/staff\\\/users\\\/\[\^\/\]\+\$\/, label: "Person" \}/);
});

test("no permission key was invented or dropped by the grouping", () => {
  // `PERMISSION_META` is the catalogue the seeding route writes; the grouping
  // must not have introduced a key it does not know about.
  for (const group of PERMISSION_GROUPS) {
    for (const key of permissionsInGroup(group.id)) {
      assert.ok(key in PERMISSION_META, `${key} is grouped but has no metadata`);
    }
  }
});
