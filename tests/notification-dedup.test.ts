import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  NOTIFICATION_ALERTS,
  NOTIFICATION_ALERTS_BY_KIND,
  PRIORITY_RANK,
  alertHref,
  notificationEventKey,
  previewMessage,
  resolutionEventKey,
  type NotificationAlertKind,
} from "../src/lib/comms/notificationEvents.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

function filesUnder(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(path, match));
    else if (match.test(entry.name)) out.push(path);
  }
  return out;
}

const SOURCE_FILES = filesUnder("src", /\.tsx?$/);

/** Source with comments removed — several comments quote the thing under ban. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// The key is what makes a duplicate unrepresentable
// ---------------------------------------------------------------------------

test("the same logical event yields the same key", () => {
  const a = notificationEventKey("order.new_direct", "order-1");
  const b = notificationEventKey("order.new_direct", "order-1");
  assert.equal(a, b, "two calls for the same event must produce one key or nothing is deduplicated");
});

test("different subjects yield different keys", () => {
  assert.notEqual(
    notificationEventKey("order.new_direct", "order-1"),
    notificationEventKey("order.new_direct", "order-2")
  );
});

test("a discriminator distinguishes a genuinely new occurrence", () => {
  // Stock going low, being restocked, and going low again is two real events.
  assert.notEqual(
    notificationEventKey("inventory.low_stock", "product-1", "alert-1"),
    notificationEventKey("inventory.low_stock", "product-1", "alert-2")
  );
});

test("a resolution is a distinct event from the alert it closes", () => {
  const alert = notificationEventKey("inventory.low_stock", "product-1", "alert-1");
  const resolved = resolutionEventKey("inventory.low_stock", "product-1", "alert-1");
  assert.notEqual(alert, resolved);
  assert.ok(resolved.startsWith(alert), "the resolution should be recognisable as belonging to its alert");
});

test("keys are index-safe and bounded", () => {
  const key = notificationEventKey("order.new_direct", "a".repeat(400), "b".repeat(400));
  assert.ok(key.length <= 200, `key was ${key.length} characters`);
  assert.match(key, /^[a-zA-Z0-9._:-]+$/, "a key must be greppable and safe in an index");
});

test("hostile subject text cannot reshape a key", () => {
  const key = notificationEventKey("order.new_direct", "a b,c(d)e\\f'g\"h");
  assert.match(key, /^[a-zA-Z0-9._:-]+$/);
  assert.ok(!key.includes(" "));
});

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("every alert kind has a spec, a permission and a deep link", () => {
  for (const spec of NOTIFICATION_ALERTS) {
    assert.ok(spec.permissionKey.includes("."), `${spec.kind} has no permission`);
    assert.ok(spec.title.length > 2, `${spec.kind} has no title`);
    const href = alertHref(spec.kind, "subject-1");
    assert.ok(href.startsWith("/staff/"), `${spec.kind} does not deep-link into the staff area`);
  }
});

test("a deep link points at a record, not at a list, wherever there is a record", () => {
  // The pass-10 defect: "5 more in the order cockpit" landed on an unfiltered
  // list, costing the reader the same search every time.
  assert.equal(alertHref("order.new_direct", "abc"), "/staff/orders/abc");
  assert.equal(alertHref("return.requested", "abc"), "/staff/orders/abc");
  assert.equal(alertHref("inventory.low_stock", "p1"), "/staff/inventory/p1");
  assert.equal(alertHref("production.overdue", "j1"), "/staff/production/j1");
});

test("only resolvable kinds may announce a resolution", () => {
  const resolvable = NOTIFICATION_ALERTS.filter((spec) => spec.resolvable).map((spec) => spec.kind);
  // Stock and integration conditions clear on their own; a new order does not.
  assert.ok(resolvable.includes("inventory.low_stock"));
  assert.ok(resolvable.includes("inventory.out_of_stock"));
  assert.ok(!resolvable.includes("order.new_direct"), "a new order does not un-happen");
  assert.ok(!resolvable.includes("refund.failed"), "a failed refund is closed by retrying it, not by clearing");
});

test("blocker priority is reserved for things that stop the shop working", () => {
  const blockers = NOTIFICATION_ALERTS.filter((spec) => spec.priority === "blocker").map((spec) => spec.kind);
  assert.deepEqual(
    blockers.sort(),
    ["ops.integration_blocker", "ops.webhook_failure", "refund.failed"].sort(),
    "a badge that is always red is a badge nobody reads"
  );
  assert.ok(PRIORITY_RANK.blocker < PRIORITY_RANK.high);
});

test("each alert is routed to the permission that can act on it", () => {
  // Not `orders.manage` for everything: telling a machinist about a refund they
  // cannot issue is noise, and hiding a stock alert from the person who
  // restocks is worse.
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["refund.failed"].permissionKey, "refunds.issue");
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["return.requested"].permissionKey, "returns.review");
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["cancellation.requested"].permissionKey, "cancellations.review");
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["inventory.low_stock"].permissionKey, "inventory.view");
  assert.equal(NOTIFICATION_ALERTS_BY_KIND["ops.email_failure"].permissionKey, "emails.view");
});

// ---------------------------------------------------------------------------
// The producers
// ---------------------------------------------------------------------------

test("createNotification accepts an event key and treats a duplicate as success", () => {
  const source = read("src/lib/notifications.ts");
  assert.match(source, /eventKey\?: string \| null/);
  assert.match(source, /event_key: eventKey \?\? null/);
  // A unique violation *is* the mechanism working. Logging it as an error would
  // fill the logs with successful deduplication.
  assert.match(source, /if \(isDuplicateEvent\(error\)\) return \{ created: false \}/);
});

test("there is exactly one way to raise a staff alert", () => {
  /*
   * `notifyStaffByPermission` was pass 8's helper and did the same job without
   * deduplication, a priority, or a catalogue. Two ways to notify staff is how
   * half the alerts end up undeduplicated: the next one gets written against
   * whichever helper the author finds first.
   */
  // Comments are stripped: the removal is documented in `orderNotifications.ts`
  // by name, and that explanation is the thing most worth keeping.
  const usages = SOURCE_FILES.filter((file) => /notifyStaffByPermission/.test(stripComments(read(file))));
  assert.deepEqual(usages, [], "notifyStaffByPermission must not come back alongside raiseOperationalAlert");
});

test("every operational alert goes through the deduplicating helper", () => {
  const source = read("src/lib/comms/operationalAlerts.ts");
  assert.match(source, /eventKey,/, "the fan-out must pass the key to every recipient");
  assert.match(source, /notificationEventKey\(input\.kind, input\.subjectId, input\.discriminator\)/);
});

test("a notification is written per recipient, not per event", () => {
  // The index is on (user_id, event_key). Scoping it globally would deliver the
  // alert to whoever was resolved first and to nobody else.
  const migration = read("supabase/migrations/20260806030000_communications_center.sql");
  assert.match(migration, /on public\.notifications \(user_id, event_key\)/);
  assert.match(migration, /where event_key is not null/, "existing rows must not need a backfill");
});

test("no alert carries a customer's own words into a preview", () => {
  /*
   * A preview line appears in a bell, a badge and potentially a push. A
   * customer's message body, note or address must not travel that far — the
   * order page is where those are read.
   */
  const producers = SOURCE_FILES.filter((file) => /raiseOperationalAlert\(/.test(read(file)));
  assert.ok(producers.length >= 6, `expected the alert producers, found ${producers.length}`);
  for (const file of producers) {
    for (const call of read(file).matchAll(/raiseOperationalAlert\(\{([\s\S]*?)\n\s*\}\)/g)) {
      for (const banned of ["body", "message_body", "customer_note", "internal_note", "staff_note"]) {
        assert.ok(
          !call[1].includes(banned),
          `${file} puts ${banned} into a notification preview`
        );
      }
      // An address, but not the `ops.email_failure` kind, which merely names
      // the channel that broke.
      assert.ok(
        !/\.email(?!_)/.test(call[1]),
        `${file} puts an email address into a notification preview`
      );
    }
  }
});

test("alerting never throws into the action that produced it", () => {
  const source = read("src/lib/comms/operationalAlerts.ts");
  // A customer's refund must not be rolled back because a bell did not ring.
  assert.match(source, /} catch \(error\) \{\s*console\.error\("raiseOperationalAlert failed"/);
  assert.match(source, /return null;/);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("the operational events the brief names are all wired", () => {
  const source = SOURCE_FILES.map(read).join("\n");
  const required: NotificationAlertKind[] = [
    "order.new_direct",
    "order.new_request",
    "order.payment_received",
    "order.payment_failed",
    "order.customer_information_received",
    "order.ready_to_fulfill",
    "order.ready_for_pickup",
    "cancellation.requested",
    "return.requested",
    "refund.failed",
    "inventory.low_stock",
    "inventory.out_of_stock",
    "ops.email_failure",
    "ops.webhook_failure",
  ];
  const missing = required.filter((kind) => !source.includes(`"${kind}"`));
  assert.deepEqual(missing, [], `these alert kinds are catalogued but nothing raises them: ${missing.join(", ")}`);
});

test("previews are trimmed rather than allowed to run long", () => {
  const long = "a".repeat(400);
  const preview = previewMessage(long);
  assert.ok(preview.length <= 200, `preview was ${preview.length}`);
  assert.ok(preview.endsWith("…"));
  assert.equal(previewMessage("  spaced   out  "), "spaced out");
});
