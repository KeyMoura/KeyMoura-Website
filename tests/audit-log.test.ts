import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

import {
  AUDIT_ACTIONS,
  AUDIT_AREAS,
  AUDIT_AREA_LABELS,
  actionArea,
  actionLabel,
  actionsForArea,
  describeAction,
  knownActions,
} from "../src/lib/audit/actions.ts";
import {
  buildChangeSet,
  fieldLabel,
  formatAuditValue,
  isEmptyChangeSet,
  isSensitiveField,
  renderChanges,
  summarizeChanges,
} from "../src/lib/audit/diff.ts";
import { auditLinks } from "../src/lib/audit/links.ts";
import {
  AUDIT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  auditFiltersToQuery,
  hasActiveFilters,
  parseAuditFilters,
} from "../src/lib/audit/query.ts";
import { isRetainedAuditEvent } from "../src/lib/audit/retention.ts";
import { ORDER_AUDIT_FIELDS, resolveOrderAction } from "../src/lib/audit/orderRules.ts";

/**
 * The audit log.
 *
 * Everything here is testable without a database because the rules live in pure
 * modules. The schema-side guarantees — that anon cannot read, that history
 * cannot be rewritten — are enforced by grants, an RLS policy and a trigger, and
 * were verified against production in a rolled-back transaction; what this file
 * can check is that the *code* never asks for something those rules forbid, and
 * that the presentation of an event is honest.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const path = `${dir}/${entry}`;
    if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Action taxonomy
// ---------------------------------------------------------------------------

test("every canonical action has a friendly label and a real area", () => {
  for (const [action, definition] of Object.entries(AUDIT_ACTIONS)) {
    assert.ok(definition.label.trim().length > 3, `${action} has no usable label`);
    assert.ok(
      (AUDIT_AREAS as readonly string[]).includes(definition.area),
      `${action} is filed under "${definition.area}", which is not an area`
    );
    assert.notEqual(definition.label, action, `${action} was not given a friendly label`);
  }
});

test("machine names stay internal and friendly labels reach the UI", () => {
  // The three examples the audit pass was specified against.
  assert.equal(actionLabel("order.status_changed"), "Changed order status");
  assert.equal(actionLabel("production.linked_to_order"), "Linked production job to order");
  assert.equal(actionLabel("inventory.adjusted"), "Adjusted inventory");
});

test("an unregistered action is still readable rather than hidden", () => {
  // A row written by a newer deployment must not disappear from an older one's
  // list. It gets a humanized label and a best-guess area, never an empty cell.
  const described = describeAction("order.something_new");
  assert.equal(described.label, "Something new");
  assert.equal(described.area, "orders");

  const unknown = describeAction("totally.unheard_of");
  assert.ok(unknown.label.length > 0);
  assert.equal(unknown.area, "system");
});

test("legacy event types keep working and are filed in the right area", () => {
  // 46 rows and 115 call sites already used these names. Renaming them would
  // have orphaned the history.
  assert.equal(actionArea("staff.order.refund_requested"), "orders");
  assert.equal(actionArea("staff.inventory.adjusted"), "inventory");
  assert.equal(actionArea("admin.roles.set"), "security");
  assert.equal(actionArea("moderation.restriction.set"), "moderation");
  assert.equal(actionLabel("staff.order.cancelled"), "Cancelled order");
});

test("every area has a label and at least one action to filter by", () => {
  for (const area of AUDIT_AREAS) {
    assert.ok(AUDIT_AREA_LABELS[area], `${area} has no label`);
    assert.ok(actionsForArea(area).length > 0, `${area} would render an empty action filter`);
  }
});

test("every audit event type used in the codebase is retained and named", () => {
  /*
   * The silent-drop trap.
   *
   * `logAuditEvent` discards anything whose type matches no retained family,
   * and says nothing when it does. An event that is written correctly, passes
   * review, and simply never appears is the failure this asserts against.
   */
  const eventTypes = new Set<string>();
  for (const file of walk("src")) {
    const source = read(file);
    for (const match of source.matchAll(/eventType: ?"([a-z0-9._]+)"/g)) eventTypes.add(match[1]);
    for (const match of source.matchAll(/action: ?"([a-z0-9._]+)"/g)) eventTypes.add(match[1]);
  }

  assert.ok(eventTypes.size > 20, "the scan found suspiciously few event types");

  for (const eventType of eventTypes) {
    // `job.*` are production timeline events, not audit events.
    if (eventType.startsWith("job.")) continue;
    assert.ok(
      isRetainedAuditEvent(eventType, "admin"),
      `${eventType} would be silently discarded by the retention filter`
    );
  }
});

test("high-volume member activity stays out of the audit log", () => {
  assert.equal(isRetainedAuditEvent("forum.post_vote", "member"), false);
  assert.equal(isRetainedAuditEvent("forum.post_view", "member"), false);
  assert.equal(isRetainedAuditEvent("garage.update", "member"), false);
  // But the destructive moderation actions are kept.
  assert.equal(isRetainedAuditEvent("forum.post_delete", null), true);
  assert.equal(isRetainedAuditEvent("forum.thread_delete", null), true);
});

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

test("only allowlisted fields that actually changed become a diff", () => {
  const before = { status: "in_progress", agreed_price_cents: 4000, staff_notes: "private" };
  const after = { status: "ready", agreed_price_cents: 4000, staff_notes: "changed" };

  const changes = buildChangeSet(before, after, ["status", "agreed_price_cents"]);

  assert.deepEqual(Object.keys(changes), ["status"], "an unchanged field must not appear");
  assert.deepEqual(changes.status, { before: "in_progress", after: "ready" });
  assert.ok(!("staff_notes" in changes), "a field outside the allowlist must not be diffed");
});

test("a no-op save produces no change set at all", () => {
  const row = { status: "ready", agreed_price_cents: 4500 };
  const changes = buildChangeSet(row, { ...row }, ["status", "agreed_price_cents"]);
  assert.ok(isEmptyChangeSet(changes), "an untouched save must not create an event");
});

test("null, undefined and empty string are the same absence", () => {
  // Clearing an already-empty box is not a change anyone made.
  assert.ok(isEmptyChangeSet(buildChangeSet({ note: null }, { note: "" }, ["note"])));
  assert.ok(isEmptyChangeSet(buildChangeSet({ note: undefined }, { note: null }, ["note"])));
  assert.ok(isEmptyChangeSet(buildChangeSet({ note: "  " }, { note: null }, ["note"])));

  // But setting one genuinely is.
  const changes = buildChangeSet({ note: null }, { note: "hello" }, ["note"]);
  assert.deepEqual(changes.note, { before: null, after: "hello" });
});

test("long text is recorded as a length, never as a body", () => {
  const long = "x".repeat(500);
  const changes = buildChangeSet({ description: "short" }, { description: long }, ["description"]);
  assert.equal(changes.description.summarized, true);
  assert.equal(changes.description.after, 500);
  assert.notEqual(changes.description.after, long);
});

test("money is stored as cents and rendered as currency", () => {
  const changes = buildChangeSet(
    { agreed_price_cents: 4000 },
    { agreed_price_cents: 4500 },
    ["agreed_price_cents"]
  );
  // Stored as integers, so the column stays queryable and locale-independent.
  assert.deepEqual(changes.agreed_price_cents, { before: 4000, after: 4500 });
  // Rendered as the shop reads it.
  assert.equal(formatAuditValue("agreed_price_cents", 4500), "$45.00");
  assert.equal(summarizeChanges(changes), "$40.00 → $45.00");
});

test("status enums resolve to the words staff use", () => {
  assert.equal(formatAuditValue("status", "in_progress"), "In production");
  assert.equal(formatAuditValue("fulfillment_status", "ready_for_pickup"), "Ready for pickup");
  assert.equal(formatAuditValue("priority", "high"), "High");
});

test("orders and production jobs do not borrow each other's status words", () => {
  /*
   * Both tables have a `status` column and both use the value `in_progress`.
   * A single global label map would render one of them wrong on every row —
   * plausibly wrong, which is the dangerous kind for an audit log.
   */
  assert.equal(formatAuditValue("status", "in_progress", false, "order"), "In production");
  assert.equal(formatAuditValue("status", "in_progress", false, "production_job"), "In progress");
});

test("the specified example renders exactly as specified", () => {
  // "Ethan changed KM-0012 status / In production → Ready for pickup"
  const changes = buildChangeSet({ status: "in_progress" }, { status: "ready_for_pickup" }, ["status"]);
  const rendered = renderChanges(changes, "production_job");
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].label, "Status");
  assert.equal(rendered[0].before, "In progress");
  assert.equal(rendered[0].after, "Ready for pickup");

  // "Normal → High"
  const priority = buildChangeSet({ priority: "normal" }, { priority: "high" }, ["priority"]);
  assert.equal(summarizeChanges(priority, "production_job"), "Normal → High");
});

test("inventory records the resulting quantity and the delta", () => {
  // "Inventory adjusted / 12 → 9 / Delta: -3"
  const changes = { inventory_quantity: { before: 12, after: 9 } };
  assert.equal(summarizeChanges(changes), "12 → 9");
  assert.equal(renderChanges(changes)[0].label, "On hand");
});

test("several changes summarize by name rather than as a wall of arrows", () => {
  const changes = buildChangeSet(
    { status: "accepted", priority: "normal", quantity: 1 },
    { status: "ready", priority: "high", quantity: 4 },
    ["status", "priority", "quantity"]
  );
  const summary = summarizeChanges(changes);
  assert.ok(summary && summary.includes("and 1 more"), `unexpected summary: ${summary}`);
});

// ---------------------------------------------------------------------------
// Sensitive data
// ---------------------------------------------------------------------------

test("secrets are refused even when a caller allowlists them", () => {
  /*
   * The deny check runs *after* the allowlist on purpose: a future caller
   * adding `password_hash` to its field list must get nothing rather than a
   * leak. Naming a field is not permission to record it.
   */
  const sensitive = [
    "password",
    "password_hash",
    "access_token",
    "refresh_token",
    "api_key",
    "stripe_secret_key",
    "webhook_secret",
    "session_id",
    "cookie",
    "authorization",
    "verification_code",
    "service_role_key",
    "card_number",
    "cvv",
    "otp",
  ];

  for (const field of sensitive) {
    assert.equal(isSensitiveField(field), true, `${field} is not recognised as sensitive`);
    const changes = buildChangeSet({ [field]: "old-value" }, { [field]: "new-value" }, [field]);
    assert.ok(isEmptyChangeSet(changes), `${field} reached the change set`);
    assert.ok(!JSON.stringify(changes).includes("new-value"), `${field}'s value leaked`);
  }
});

test("business fields that merely contain a scary word are still recorded", () => {
  // A blanket /code/ pattern would have swallowed all of these, and they are
  // exactly what an audit log is for.
  for (const field of ["reason_code", "tax_code", "discount_code", "order_number", "postcode"]) {
    assert.equal(isSensitiveField(field), false, `${field} was wrongly treated as a secret`);
  }
  const changes = buildChangeSet({ tax_code: "A" }, { tax_code: "B" }, ["tax_code"]);
  assert.deepEqual(changes.tax_code, { before: "A", after: "B" });
});

test("no instrumented route copies a note body or an address into an audit event", () => {
  /*
   * The audit log is read by everyone holding `audit.view`, which is a wider
   * group than the order page. Internal notes, customer notes and shipping
   * addresses stay on the record they belong to.
   */
  const forbidden = ["staff_notes", "internal_notes", "customer_visible_notes", "shipping_address", "final_review_note"];
  for (const field of forbidden) {
    assert.ok(
      !(ORDER_AUDIT_FIELDS as readonly string[]).includes(field),
      `${field} is in the order audit field list`
    );
  }

  const productionServer = read("src/lib/production/server.ts");
  const productionFields = productionServer.slice(
    productionServer.indexOf("PRODUCTION_AUDIT_FIELDS"),
    productionServer.indexOf("] as const", productionServer.indexOf("PRODUCTION_AUDIT_FIELDS"))
  );
  for (const field of ["internal_notes", "customer_visible_notes", "description"]) {
    assert.ok(!productionFields.includes(`"${field}"`), `${field} is in the production audit field list`);
  }
});

test("the catalog trigger never copies marketing prose into the log", () => {
  const migration = read("supabase/migrations/20260809200000_audit_event_model.sql");
  // These are compared, but only their length is stored.
  assert.match(migration, /summarized_columns constant text\[\] := array\['short_description', 'description', 'detail_content'\]/);
  assert.match(migration, /to_jsonb\(length\(before_value::text\)\)/);
});

// ---------------------------------------------------------------------------
// Action resolution
// ---------------------------------------------------------------------------

test("one save produces one event, named for its most consequential change", () => {
  assert.equal(resolveOrderAction({ status: { before: "accepted", after: "ready" } }), "order.status_changed");
  assert.equal(resolveOrderAction({ status: { before: "accepted", after: "cancelled" } }), "order.cancelled");
  assert.equal(
    resolveOrderAction({ agreed_price_cents: { before: 4000, after: 4500 } }),
    "order.price_changed"
  );
  assert.equal(resolveOrderAction({}), "order.updated");

  // A save that moved both is one event; the diff still carries both fields.
  assert.equal(
    resolveOrderAction({
      status: { before: "accepted", after: "ready" },
      agreed_price_cents: { before: 4000, after: 4500 },
    }),
    "order.status_changed"
  );
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const JOB_ID = "22222222-3333-4444-5555-666666666666";
const PRODUCT_ID = "33333333-4444-5555-6666-777777777777";

test("an event links to the records it touched, without duplicates", () => {
  const links = auditLinks({
    entityType: "order",
    entityId: ORDER_ID,
    relatedOrderId: ORDER_ID,
    relatedProductionJobId: JOB_ID,
  });

  assert.deepEqual(
    links.map((link) => link.href),
    [`/staff/orders/${ORDER_ID}`, `/staff/production/${JOB_ID}`],
    "the entity and an identical related id must produce one link, not two"
  );
});

test("every link target is a staff route that exists", () => {
  const links = [
    ...auditLinks({ entityType: "order", entityId: ORDER_ID }),
    ...auditLinks({ entityType: "production_job", entityId: JOB_ID }),
    ...auditLinks({ entityType: "product", entityId: PRODUCT_ID }),
    ...auditLinks({ entityType: "role", entityId: "moderator" }),
  ];

  const routeFor = (href: string) =>
    href
      .replace(ORDER_ID, "[id]")
      .replace(JOB_ID, "[id]")
      .replace(PRODUCT_ID, "[productId]");

  const known = new Set([
    "/staff/orders/[id]",
    "/staff/production/[id]",
    "/staff/inventory/[productId]",
    "/staff/security/roles",
  ]);

  for (const link of links) {
    assert.ok(known.has(routeFor(link.href)), `${link.href} is not a route that exists`);
  }
  assert.equal(links.length, 4);
});

test("a non-uuid id never becomes a link", () => {
  // A malformed id would produce a 404 that reads as "the record was deleted".
  assert.deepEqual(auditLinks({ entityType: "order", entityId: "not-a-uuid" }), []);
  assert.deepEqual(auditLinks({ entityType: "product", entityId: "" }), []);
});

// ---------------------------------------------------------------------------
// Filters and paging
// ---------------------------------------------------------------------------

test("filters survive a round trip through the URL", () => {
  const query = auditFiltersToQuery({
    search: "KM-0012",
    area: "orders",
    action: "order.status_changed",
    actor: ORDER_ID,
    from: "2026-08-01",
    to: "2026-08-09",
    orderId: ORDER_ID,
  });
  const parsed = parseAuditFilters(new URLSearchParams(query));

  assert.equal(parsed.search, "KM-0012");
  assert.equal(parsed.area, "orders");
  assert.equal(parsed.action, "order.status_changed");
  assert.equal(parsed.actor, ORDER_ID);
  assert.equal(parsed.from, "2026-08-01");
  assert.equal(parsed.orderId, ORDER_ID);
  assert.ok(hasActiveFilters(parsed));
});

test("a stale or hostile parameter is refused rather than passed through", () => {
  const parsed = parseAuditFilters(
    new URLSearchParams({
      area: "'; drop table audit_logs; --",
      actor: "not-a-uuid",
      from: "yesterday",
      order: "../../etc/passwd",
      size: "100000",
    })
  );

  assert.equal(parsed.area, null, "an unknown area must not reach the query");
  assert.equal(parsed.actor, null);
  assert.equal(parsed.from, null);
  assert.equal(parsed.orderId, null);
  assert.equal(parsed.pageSize, AUDIT_MAX_PAGE_SIZE, "page size must be capped");
  assert.ok(!hasActiveFilters(parsed));
});

test("system is a real actor filter, not a user id", () => {
  const parsed = parseAuditFilters(new URLSearchParams({ actor: "system" }));
  assert.equal(parsed.actor, "system");
});

test("paging defaults to a bounded page, newest first", () => {
  const parsed = parseAuditFilters(new URLSearchParams());
  assert.equal(parsed.pageSize, AUDIT_PAGE_SIZE);
  assert.ok(AUDIT_PAGE_SIZE === 50 || AUDIT_PAGE_SIZE === 100);
  assert.equal(parsed.cursor, null);

  const route = read("src/app/api/staff/audit/route.ts");
  assert.match(route, /\.order\("occurred_at", \{ ascending: false \}\)/);
  // Ties broken by id, or a page boundary inside a burst of same-timestamp
  // events silently drops rows.
  assert.match(route, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(route, /\.lt\("occurred_at", filters\.cursor\)/);
});

// ---------------------------------------------------------------------------
// Server-side only, and read-only
// ---------------------------------------------------------------------------

test("the audit page never queries the table from the browser", () => {
  /*
   * The page this replaces did exactly that, as `authenticated`, which holds no
   * SELECT grant — so every read failed with 42501 and the swallowed rejection
   * rendered as "No audit events found" over 46 real rows. It also filtered and
   * sorted whatever it had managed to fetch in the browser.
   */
  const page = read("src/app/staff/audit/page.tsx");
  assert.ok(!page.includes('from("audit_logs")'), "the page must not read the table directly");
  assert.match(page, /fetch\(`\/api\/staff\/audit\?/);

  // No client-side re-filtering or re-sorting of the fetched page.
  assert.ok(!/\.filter\(\s*\(\s*(?:event|row|r|e)\s*\)\s*=>/.test(page), "filtering must happen on the server");
  assert.ok(!page.includes(".sort((a, b)"), "sorting must happen on the server");
});

test("the audit API refuses anyone without an audit permission", () => {
  for (const path of ["src/app/api/staff/audit/route.ts", "src/app/api/staff/audit/actors/route.ts"]) {
    const route = read(path);
    assert.match(route, /requireAnyPermission\(req, \["audit\.view", "audit\.read"\]\)/, `${path} is unguarded`);
    assert.match(route, /status: 403/);
  }
});

test("reading the audit log does not write to the audit log", () => {
  // Otherwise the table grows faster from being looked at than from anything
  // happening, and every page view buries the events worth seeing.
  //
  // Matched as a *call*, with comments stripped first. A substring test failed
  // the moment a comment explained what `recordAuditEvent` does elsewhere,
  // which is a test measuring prose rather than behaviour.
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const path of ["src/app/api/staff/audit/route.ts", "src/app/api/staff/audit/actors/route.ts"]) {
    const code = stripComments(read(path));
    assert.ok(!/\brecordAuditEvent\s*\(/.test(code), `${path} records an event for a read`);
    assert.ok(!/\blogAuditEvent\s*\(/.test(code), `${path} records an event for a read`);
    assert.ok(!/\brecordAuditEventStrict\s*\(/.test(code), `${path} records an event for a read`);
  }
});

test("no route inserts, updates or deletes audit history outside the writer", () => {
  /*
   * History is append-only in the database — a trigger refuses UPDATE and
   * DELETE for every role including `service_role`. This asserts the code does
   * not even try, so the guarantee is not discovered at runtime.
   */
  for (const file of walk("src")) {
    if (file === "src/lib/audit/events.ts") continue;
    const source = read(file);
    const touches = source.match(/from\("audit_logs"\)[\s\S]{0,120}/g) ?? [];
    for (const usage of touches) {
      assert.ok(!usage.includes(".update("), `${file} updates audit history`);
      assert.ok(!usage.includes(".delete("), `${file} deletes audit history`);
      assert.ok(!usage.includes(".upsert("), `${file} upserts audit history`);
      assert.ok(!usage.includes(".insert("), `${file} writes audit rows outside recordAuditEvent`);
    }
  }
});

test("the migration makes the log append-only and staff-readable", () => {
  const migration = read("supabase/migrations/20260809200000_audit_event_model.sql");

  // Customers and anon get nothing.
  assert.match(migration, /revoke all on table public\.audit_logs from anon;/);
  // Staff can read; nobody gets a write grant through RLS.
  assert.match(migration, /grant select on table public\.audit_logs to authenticated;/);
  assert.ok(
    !/grant\s+(insert|update|delete)[^;]*to authenticated/i.test(migration),
    "authenticated must never be granted a write"
  );

  // The service role may insert, and may not rewrite history.
  assert.match(migration, /grant select, insert on table public\.audit_logs to service_role;/);
  assert.match(migration, /revoke update, delete, truncate on table public\.audit_logs from service_role;/);

  // The old FOR ALL policies are gone, replaced by a read-only one.
  assert.match(migration, /drop policy if exists "staff manage" on public\.audit_logs;/);
  assert.match(migration, /for select to authenticated/);
  assert.match(migration, /public\.is_account_admitted\(\) and public\.is_staff_user\(\)/);

  // And the trigger that makes it true regardless of grants.
  assert.match(migration, /append-only: history cannot be deleted/);
  assert.match(migration, /append-only: history cannot be modified/);
  assert.match(migration, /append-only: history cannot be truncated/);
});

test("a failed mutation cannot produce a success event", () => {
  /*
   * The order route writes its audit event only after the guarded update has
   * reported an affected row. Writing it earlier would record a change the
   * `.eq(status)` guard may have refused — a false success, which is the exact
   * defect the guard exists to prevent.
   */
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  const conflictReturn = route.indexOf("Nothing was applied");
  const auditCall = route.indexOf("recordOrderAudit({");
  assert.ok(conflictReturn > 0 && auditCall > 0);
  assert.ok(auditCall > conflictReturn, "the audit write must come after the conflict check");
});

test("an audit write that fails is reported rather than swallowed", () => {
  const route = read("src/app/api/staff/orders/[id]/route.ts");
  assert.match(route, /auditFailed: true/);

  const inventory = read("src/app/api/staff/inventory/[productId]/route.ts");
  assert.match(inventory, /auditFailed: true/);
});

test("security-critical writes use the strict path", () => {
  // A role change nobody can attribute is itself the incident.
  for (const path of [
    "src/app/api/staff/security/users/[id]/role/route.ts",
    "src/app/api/staff/security/roles/route.ts",
    "src/app/api/staff/security/roles/[key]/route.ts",
  ]) {
    assert.match(read(path), /recordAuditEventStrict/, `${path} does not audit strictly`);
  }
  assert.match(read("src/lib/audit/security.ts"), /recordAuditEventStrict/);
});

test("automated changes are never attributed to a person", () => {
  const events = read("src/lib/audit/events.ts");
  // The provider branch takes no user id at all.
  const providerBranch = events.slice(events.indexOf('case "provider":'), events.indexOf('case "scheduled":'));
  assert.match(providerBranch, /actor_user_id: null/);
  assert.ok(!providerBranch.includes("actor.userId"), "a provider event must not carry a user id");
});

test("metadata is filtered, capped, and never a whole request body", () => {
  const events = read("src/lib/audit/events.ts");
  assert.match(events, /MAX_METADATA_KEYS/);
  assert.match(events, /MAX_METADATA_STRING/);
  assert.match(events, /if \(isSensitiveField\(key\)\) continue;/);
});

test("no fabricated history: nothing backfills events from existing tables", () => {
  /*
   * A blank log before deployment is correct. Reconstructing events from
   * `order_status_history` would produce rows that look like audit entries,
   * carry an actor nobody verified, and are guesses.
   */
  const migration = read("supabase/migrations/20260809200000_audit_event_model.sql");
  const inserts = migration.match(/insert into public\.audit_logs/g) ?? [];
  // Exactly one: the catalog trigger's own insert.
  assert.equal(inserts.length, 1, "the migration must not seed historical events");
  assert.ok(!migration.includes("from public.order_status_history"));
  assert.ok(!migration.includes("from public.production_job_events"));
});

test("a row without a stored summary still shows its before and after", () => {
  /*
   * The catalog trigger writes in SQL and cannot compute a summary, so every
   * product event lands with `summary` null. Left as-is, a price change rendered
   * as "Changed product price / Shift Knob" with the money nowhere on the row —
   * visible only after expanding it. The list route derives one from `changes`.
   */
  const route = read("src/app/api/staff/audit/route.ts");
  assert.match(route, /summary: row\.summary \?\? summarizeChanges\(row\.changes, entityType\)/);

  // And the derivation itself produces the specified line.
  const changes = { starting_price_cents: { before: 4000, after: 4500 } };
  assert.equal(summarizeChanges(changes, "product"), "$40.00 → $45.00");
});

test("known action names are stable and unique", () => {
  const actions = knownActions();
  assert.equal(new Set(actions).size, actions.length, "an action is registered twice");
  for (const action of actions) {
    assert.match(action, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, `${action} does not follow the naming convention`);
  }
});

test("field labels are human, not column names", () => {
  assert.equal(fieldLabel("starting_price_cents"), "Price");
  assert.equal(fieldLabel("low_stock_threshold"), "Low stock threshold");
  assert.equal(fieldLabel("fulfillment_status"), "Fulfillment status");
  // An unregistered column still reads as words.
  assert.equal(fieldLabel("some_new_column"), "Some new column");
});
