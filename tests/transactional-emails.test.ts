import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  CUSTOMER_SAFE_VARIABLES,
  EMAIL_EVENTS,
  EMAIL_TEMPLATE_KEYS,
  INTERNAL_ONLY_FIELDS,
  RESENDABLE_TEMPLATE_KEYS,
  audienceForTemplate,
  isResendableTemplate,
  classifyEmailFailure,
  maskRecipient,
} from "../src/lib/comms/emailEvents.ts";

/**
 * The transactional email matrix, enforced.
 *
 * `docs/TRANSACTIONAL_EMAIL_MATRIX.md` is prose and prose drifts. These tests
 * are what stop it: a `sendCommerceEmail` call whose template is not in the
 * catalogue fails here, a catalogued template with no seeded row fails here,
 * and an internal-note column name appearing in a send path fails here.
 */

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

const SOURCE_FILES = [...filesUnder("src", /\.tsx?$/)];
const SOURCE = SOURCE_FILES.map(read).join("\n");
const MIGRATIONS = filesUnder("supabase/migrations", /\.sql$/).map(read).join("\n");

// ---------------------------------------------------------------------------
// The catalogue and the code agree
// ---------------------------------------------------------------------------

test("every template key the code sends is in the catalogue", () => {
  const used = new Set(
    [...SOURCE.matchAll(/templateKey:\s*"([a-z_]+)"/g)].map((match) => match[1])
  );
  // Ternaries: `templateKey: settled ? "a" : "b"` yields both arms.
  for (const match of SOURCE.matchAll(/templateKey:\s*[^,\n]*\?[^,\n]*"([a-z_]+)"[^,\n]*:[^,\n]*"([a-z_]+)"/g)) {
    used.add(match[1]);
    used.add(match[2]);
  }
  const known = new Set<string>(EMAIL_TEMPLATE_KEYS);
  const unknown = [...used].filter((key) => !known.has(key));
  assert.deepEqual(unknown, [], `these template keys are sent but not catalogued: ${unknown.join(", ")}`);
});

test("every catalogued template has a seeded row", () => {
  const seeded = new Set(
    [...MIGRATIONS.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*\n?/g)].map((match) => match[1])
  );
  // The seeds are `('key', 'Name', ...)` tuples; also accept the older
  // single-line form used by the pass-5 and pass-8 migrations.
  for (const match of MIGRATIONS.matchAll(/\(\s*'([a-z_]+)'\s*,/g)) seeded.add(match[1]);

  const missing = EMAIL_TEMPLATE_KEYS.filter((key) => !seeded.has(key));
  assert.deepEqual(
    missing,
    [],
    `these templates are in the catalogue with no migration seeding them: ${missing.join(", ")}`
  );
});

test("every catalogued event names a template that exists", () => {
  const known = new Set<string>(EMAIL_TEMPLATE_KEYS);
  for (const event of EMAIL_EVENTS) {
    assert.ok(known.has(event.templateKey), `${event.id} names unknown template ${event.templateKey}`);
  }
});

test("every event states its idempotency and its trigger", () => {
  for (const event of EMAIL_EVENTS) {
    assert.ok(event.trigger.length > 20, `${event.id} has no meaningful trigger description`);
    assert.ok(event.eventKeyShape.length > 4, `${event.id} does not state how its key is built`);
    assert.ok(
      event.idempotency === "suppressed" || event.idempotency === "per_message",
      `${event.id} has no idempotency behaviour`
    );
  }
});

test("an unwired event says why it is unwired", () => {
  for (const event of EMAIL_EVENTS.filter((candidate) => !candidate.wired)) {
    assert.ok(
      event.notes && event.notes.length > 40,
      `${event.id} is recorded as unbuilt with no explanation of what it needs`
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("no event key is built from a clock", () => {
  /*
   * `Date.now()` in an event key defeats the entire scheme: every call computes
   * a fresh key, the unique index never fires, and a retried request sends a
   * second email. The one legitimate exception is the staff *test* send, which
   * is explicitly meant to be repeatable.
   */
  const offenders: string[] = [];
  for (const file of SOURCE_FILES) {
    const source = read(file);
    for (const match of source.matchAll(/eventKey:\s*`([^`]*)`/g)) {
      if (/Date\.now\(\)|new Date\(\)|Math\.random/.test(match[1])) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders.filter((entry) => !entry.includes("emails/test/route.ts")),
    [],
    `these event keys are minted from a clock and deduplicate nothing:\n${offenders.join("\n")}`
  );
});

test("the sender claims the event before sending it", () => {
  const source = read("src/lib/commerceEmail.ts");
  /*
   * The old implementation sent first and recorded afterwards, so two
   * concurrent calls with the same key both sent. These assertions pin the
   * order: the claim insert happens, and the send is gated on it succeeding.
   */
  assert.match(source, /async function claimDelivery/);
  assert.match(source, /if \(!claim\.claimed\) return \{ sent: false, suppressed: true \}/);
  const claimAt = source.indexOf("const claim = await claimDelivery");
  const sendAt = source.indexOf("resend.emails.send");
  assert.ok(claimAt > 0 && sendAt > claimAt, "the provider must not be called before the claim is taken");
});

test("a delivered message is never re-sent under the same key", () => {
  const source = read("src/lib/commerceEmail.ts");
  assert.match(source, /if \(row\.status === "sent" \|\| row\.status === "delivered"\) return \{ claimed: false, reason: "already_sent" \}/);
});

test("a failed send may be retried, and the attempt is counted", () => {
  const source = read("src/lib/commerceEmail.ts");
  assert.match(source, /attempt_count: \(row\.attempt_count \?\? 1\) \+ 1/);
  // Re-asserting the status closes the race between two retries.
  assert.match(source, /\.eq\("status", row\.status\)/);
});

test("the provider is still given the event key as its own idempotency key", () => {
  // Belt and braces: the database claim is the durable guard, and the provider
  // key catches the window where the claim committed and the process died.
  assert.match(read("src/lib/commerceEmail.ts"), /\{ idempotencyKey: input\.eventKey \}/);
});

// ---------------------------------------------------------------------------
// What may and may not reach a customer
// ---------------------------------------------------------------------------

test("no internal field is interpolated into an email", () => {
  const senders = SOURCE_FILES.filter((file) => /sendCommerceEmail|sendLifecycleNotification|notifyStaffEmail/.test(read(file)));
  assert.ok(senders.length >= 8, `expected the send sites, found ${senders.length}`);

  for (const file of senders) {
    const source = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Only the variables block matters: a route may legitimately *read* a note
    // column for its own logic, so the test looks at what is handed to the
    // template rather than at the whole file.
    for (const block of source.matchAll(/variables:\s*\{([\s\S]*?)\n\s*\}/g)) {
      for (const field of INTERNAL_ONLY_FIELDS) {
        assert.ok(
          !block[1].includes(field),
          `${file} interpolates the internal field ${field} into an email`
        );
      }
    }
  }
});

test("the customer-safe variable list is the one the templates use", () => {
  const seeded = [...MIGRATIONS.matchAll(/\{\{([a-z_]+)\}\}/g)].map((match) => match[1]);
  const allowed = new Set<string>(CUSTOMER_SAFE_VARIABLES);
  const unexpected = [...new Set(seeded)].filter((name) => !allowed.has(name));
  assert.deepEqual(unexpected, [], `templates interpolate variables outside the safe list: ${unexpected.join(", ")}`);
});

test("customer values are escaped in the HTML and stripped of line breaks in the subject", () => {
  const source = read("src/lib/commerceEmail.ts");
  // The body is interpolated first and escaped afterwards, so a variable's
  // angle brackets cannot survive into the markup.
  assert.match(source, /escapeHtml\(body\)/);
  assert.match(source, /escapeHtml\(heading\)/);
  assert.match(source, /escapeHtml\(url\)/);
  // `customer_name` comes from user metadata, which the customer controls.
  assert.match(source, /const headerSafe = \(value: string\) => value\.replace\(\/\[\\r\\n\]\+\/g, " "\)/);
  assert.match(source, /interpolateHeader\(template\?\.subject/);
});

test("every message carries a plain-text alternative built from the same strings", () => {
  const source = read("src/lib/commerceEmail.ts");
  assert.match(source, /const plainText = \[/);
  assert.match(source, /text: plainText/);
  // Built from the interpolated values, so the two versions cannot drift.
  assert.match(source, /`\\n\$\{heading\}`/);
  assert.match(source, /`\\n\$\{body\}`/);
});

test("no Stripe identifier reaches a customer email", () => {
  for (const file of SOURCE_FILES) {
    const source = read(file);
    for (const block of source.matchAll(/variables:\s*\{([\s\S]*?)\n\s*\}/g)) {
      assert.ok(
        !/stripe_[a-z_]*id/i.test(block[1]),
        `${file} puts a Stripe identifier into an email`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("provider failures are classified rather than shown raw", () => {
  assert.equal(classifyEmailFailure("You have hit the rate limit"), "rate_limited");
  assert.equal(classifyEmailFailure("The email address is invalid"), "invalid_recipient");
  assert.equal(classifyEmailFailure("fetch failed"), "provider_unavailable");
  assert.equal(classifyEmailFailure("Unauthorized: bad api key"), "provider_rejected");
  assert.equal(classifyEmailFailure(""), "unknown");
  assert.equal(classifyEmailFailure("something nobody has seen"), "unknown");
});

test("a failed customer email raises an in-app alert and never another email", () => {
  const source = read("src/lib/commerceEmail.ts");
  assert.match(source, /async function alertOnCustomerFailure/);
  // Staff alerts do not alert; that is the loop-avoidance rule.
  assert.match(source, /if \(audience !== "customer"\) return;/);
  assert.match(source, /kind: "ops\.email_failure"/);
  // Crucially, the alert path must not itself send mail.
  const alertBlock = source.slice(source.indexOf("async function alertOnCustomerFailure"), source.indexOf("async function finishDelivery"));
  assert.ok(!/sendCommerceEmail/.test(alertBlock), "alerting about a broken mailer must not use the mailer");
});

test("a suppressed send is reported as suppressed, not as a failure", () => {
  const source = read("src/lib/commerceEmail.ts");
  assert.match(source, /suppressed\?: boolean/);
});

// ---------------------------------------------------------------------------
// Resend eligibility
// ---------------------------------------------------------------------------

test("staff alerts are not resendable", () => {
  for (const event of EMAIL_EVENTS.filter((candidate) => candidate.audience === "staff")) {
    assert.equal(event.resendable, false, `${event.id} is a staff alert and must not be resendable`);
  }
});

test("every resendable template addresses a customer", () => {
  for (const key of RESENDABLE_TEMPLATE_KEYS) {
    assert.equal(audienceForTemplate(key), "customer", `${key} is resendable but is not a customer message`);
  }
});

test("isResendableTemplate refuses an unknown key", () => {
  assert.equal(isResendableTemplate("not_a_template"), false);
  assert.equal(isResendableTemplate("staff_new_request"), false);
  assert.equal(isResendableTemplate("order_shipped"), true);
});

// ---------------------------------------------------------------------------
// Recipient masking
// ---------------------------------------------------------------------------

test("masking keeps the domain and hides the local part", () => {
  const masked = maskRecipient("alexander@keymoura.com");
  assert.match(masked, /@keymoura\.com$/, "the domain must survive so a typo'd domain is spottable");
  assert.ok(!masked.includes("alexander"), "the local part must not survive intact");
  assert.equal(masked[0], "a", "the first character is kept so two customers can be told apart");
});

test("masking handles short and malformed addresses without throwing", () => {
  assert.equal(maskRecipient(""), "");
  assert.match(maskRecipient("a@b.co"), /@b\.co$/);
  assert.ok(!maskRecipient("not-an-address").includes("not-an-address"));
  assert.ok(maskRecipient("ab@x.io").length > 0);
});

test("a masked address cannot be reversed into the original", () => {
  const original = "somebody.specific@example.com";
  const masked = maskRecipient(original);
  assert.notEqual(masked, original);
  assert.ok(!masked.includes("specific"));
});

test("the matrix document lists every catalogued event", () => {
  /*
   * The document is generated from the module, and this is what stops it
   * becoming a stale copy: a new event that nobody re-rendered the doc for
   * fails here. The ledger's own count of this catalogue was wrong in three
   * consecutive passes for exactly the want of this assertion.
   */
  const doc = read("docs/TRANSACTIONAL_EMAIL_MATRIX.md");
  const missing = EMAIL_EVENTS.filter((event) => !doc.includes(`\`${event.id}\``)).map((event) => event.id);
  assert.deepEqual(missing, [], `these events are catalogued but absent from the matrix doc: ${missing.join(", ")}`);
});

test("the matrix document names the module it is generated from", () => {
  const doc = read("docs/TRANSACTIONAL_EMAIL_MATRIX.md");
  assert.match(doc, /src\/lib\/comms\/emailEvents\.ts/);
  // And it must not present itself as the definition.
  assert.match(doc, /generated from/);
});
