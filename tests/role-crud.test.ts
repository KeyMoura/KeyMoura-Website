import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ROLE_BADGE_ICONS,
  ROLE_NOT_NULL_TEXT_COLUMNS,
  ROLE_SELECT,
  isRoleBadgeIcon,
  normalizeBadgeIcon,
  roleWriteErrorMessage,
  toRoleDbColumns,
} from "../src/lib/staff/roleSchema.ts";

/**
 * Role creation, and the defect that survived pass 14's migration.
 *
 * `roles.description` is `text NOT NULL DEFAULT ''`. The create form posts only
 * `{ key, label }`; the route filled the absent description with `null`, and an
 * explicit null overrides a default rather than triggering it. Every create was
 * refused with 23502 and reported as "Could not create the role."
 *
 * Pass 14 dry-ran its migration with a hand-written insert that supplied a
 * description, which proved the *column* was fixed and never exercised the
 * *route's* payload. These tests exercise the payload.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const createRoute = read("src/app/api/staff/security/roles/route.ts");
const itemRoute = read("src/app/api/staff/security/roles/[key]/route.ts");
const page = read("src/app/staff/security/roles/page.tsx");

test("a null description is converted to the column's own default", () => {
  // The exact shape that failed: everything present, description explicitly null.
  const columns = toRoleDbColumns({ label: "Organizer", description: null, priority: 0, is_staff: false });
  assert.equal(columns.description, "", "an explicit null overrides DEFAULT '' and violates NOT NULL");
  assert.notEqual(columns.description, null);
});

test("a real description still survives", () => {
  const columns = toRoleDbColumns({ description: "Runs events" });
  assert.equal(columns.description, "Runs events");
});

test("the conversion is limited to columns that actually need it", () => {
  assert.deepEqual(ROLE_NOT_NULL_TEXT_COLUMNS, ["description"]);
  // A nullable column must keep its null: clearing a badge icon is a real
  // action, and turning it into '' would fail the CHECK constraint.
  const columns = toRoleDbColumns({ badge_icon: null });
  assert.equal(columns.badge_icon, null);
});

test("absent fields are not written at all", () => {
  // A PATCH naming one field must not blank the other nine.
  const columns = toRoleDbColumns({ label: "Support" });
  assert.deepEqual(Object.keys(columns), ["name"]);
});

test("the create route sends a string, never a null, for the description", () => {
  // Scoped to `parseCreatePayload`. `normalizeRoleRow` above it reads a row
  // *back* and a null description is correct there — the wire type is
  // `string | null`. Only the write path must never produce one.
  const parse = createRoute.match(/function parseCreatePayload[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(parse, "parseCreatePayload should be findable");
  assert.match(
    parse,
    /description: isString\(r\.description\) \? r\.description : ""/,
    "the route must not reintroduce the null"
  );
  assert.doesNotMatch(parse, /description:[^,]*: null/);
});

/**
 * Neither `key` nor `is_system` may be written.
 *
 * `key` is the primary key `profiles.role` and `role_permissions` point at, and
 * `is_system` is the flag that decides whether a role may be deleted at all.
 * Either becoming writable by adding a field to the JSON would be an
 * escalation, not a bug.
 */
test("a role cannot rewrite its own key or promote itself to built-in", () => {
  const columns = toRoleDbColumns({ key: "admin", is_system: true, label: "Sneaky" });
  assert.deepEqual(columns, { name: "Sneaky" });
});

test("creating a role grants no permissions", () => {
  // The POST body names only `roles` columns. A comment elsewhere in the file
  // mentions role_permissions, so this looks at the handler rather than the file.
  const post = createRoute.match(/export async function POST[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(post, "the POST handler should be findable");
  assert.doesNotMatch(post, /role_permissions/, "creating a role must not seed permissions");
  assert.doesNotMatch(post, /\.from\("(?!roles")/, "creating a role touches exactly one table");
  assert.match(page, /no permissions until you grant some/, "the page should say so");
});

test("every failure mode says which one it was", () => {
  const cases: [string, number, RegExp][] = [
    ["23505", 409, /already exists/i],
    ["23502", 400, /required field/i],
    ["23514", 400, /badge icon/i],
    ["23503", 409, /still refers/i],
    ["42501", 403, /not allowed/i],
  ];
  for (const [code, status, pattern] of cases) {
    const result = roleWriteErrorMessage({ code }, "create");
    assert.equal(result.status, status, `${code} should map to ${status}`);
    assert.match(result.message, pattern, `${code} should be named, not collapsed into the generic message`);
  }
});

test("an unknown failure is generic but never raw", () => {
  const result = roleWriteErrorMessage(
    { code: "XX000", message: 'relation "roles" does not exist at character 13' },
    "create"
  );
  assert.equal(result.message, "Could not create the role.");
  assert.doesNotMatch(result.message, /relation|character|roles"/, "a database error must not reach the browser");
});

test("the verb is the one the operator attempted", () => {
  assert.match(roleWriteErrorMessage({ code: "XX000" }, "update").message, /update/);
  assert.match(roleWriteErrorMessage({ code: "XX000" }, "delete").message, /delete/);
});

test("both write routes report through the shared mapper", () => {
  assert.match(createRoute, /roleWriteErrorMessage\(error, "create"\)/);
  assert.match(itemRoute, /roleWriteErrorMessage\(error, "update"\)/);
  assert.match(itemRoute, /roleWriteErrorMessage\(error, "delete"\)/);
  // The old generic string must not survive anywhere as a hard-coded response.
  assert.doesNotMatch(createRoute, /error: "Could not create the role\."/);
});

test("built-in roles and roles people hold are refused", () => {
  assert.match(itemRoute, /role\.is_system/);
  assert.match(itemRoute, /Built-in roles cannot be deleted/);
  assert.match(itemRoute, /accounts still hold/);
  assert.match(itemRoute, /\.eq\("role", roleKey\)/, "the holder count must query by role");
});

test("every write requires roles.manage", () => {
  assert.match(createRoute, /requireAnyPermission\(req, \["roles\.manage"\]\)/);
  assert.match(itemRoute, /requirePermission\(req, "roles\.manage"\)/);
  // Reading is a weaker requirement than writing, deliberately.
  assert.match(createRoute, /requireAnyPermission\(req, \["roles\.manage", "roles\.assign"\]\)/);
});

test("the badge icon allow-list is closed at both ends", () => {
  for (const icon of ROLE_BADGE_ICONS) {
    assert.ok(isRoleBadgeIcon(icon), `${icon} must be accepted`);
    assert.equal(normalizeBadgeIcon(icon), icon);
  }
  assert.ok(!isRoleBadgeIcon("rocket"), "an icon RolePill cannot draw must be refused");
  assert.equal(normalizeBadgeIcon(""), null, "no icon is a real choice");
  assert.equal(normalizeBadgeIcon("  GAVEL "), "gavel", "case and padding are normalised");
});

test("the roles list is read with the columns the table actually has", () => {
  // `label:name` and `priority:rank` — the wire vocabulary the UI consumes,
  // aliased from the real column names. Naming `label` directly is what made
  // the list answer "there are no roles" for two passes.
  assert.match(ROLE_SELECT, /label:name/);
  assert.match(ROLE_SELECT, /priority:rank/);
  assert.doesNotMatch(ROLE_SELECT, /(^|,)label(,|$)/);
});

/** The UI half: the reported message was one nobody could act on. */
test("the editor shows errors beside the form rather than in an alert", () => {
  assert.match(page, /createError \? <Notice tone="danger" role="alert">/);
  assert.match(page, /setCreateError\(isRecord\(j\) && isString\(j\.error\)/, "the server's message is surfaced");
  assert.doesNotMatch(page, /alert\(msg\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*setCreatingKey/);
});

test("a created role can be reopened immediately", () => {
  assert.match(page, /await selectRole\(key\)/, "creating should open the new role for editing");
});

test("the editor can delete a safe role and explains when it cannot", () => {
  assert.match(page, /method: "DELETE"/);
  assert.match(page, /selectedRole\.is_system \?/);
  assert.match(page, /Built in — cannot be deleted/);
  assert.match(page, /window\.confirm/, "deleting is irreversible, so it is confirmed");
});
