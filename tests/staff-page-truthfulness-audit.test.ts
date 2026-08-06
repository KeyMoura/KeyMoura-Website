import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

/**
 * The Phase 1 audit, as an enforceable rule rather than a one-time sweep.
 *
 * Pass 9 fixed "a refused query renders as a confident zero" on the dashboard
 * and the fulfillment queue, wrote down that `/staff/orders` still had it, and
 * the next pass had to find it again. A prose note does not stop a regression;
 * a test does.
 *
 * These assertions are deliberately about *shape*, because the defect is a
 * shape: rows that came from an unchecked result, and an empty state that a
 * failure can reach.
 */

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** Source with comments stripped — the comments quote the defect on purpose. */
const readCode = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every page under src/app/staff, found rather than listed, so a new one is covered. */
function staffPages(dir = "src/app/staff"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...staffPages(path));
    else if (entry.name === "page.tsx") out.push(path);
  }
  return out;
}

const PAGES = staffPages();

test("the audit actually covers the staff area", () => {
  assert.ok(PAGES.length >= 30, `expected the full staff area, found ${PAGES.length} pages`);
  for (const expected of [
    "src/app/staff/page.tsx",
    "src/app/staff/orders/page.tsx",
    "src/app/staff/fulfillment/page.tsx",
    "src/app/staff/inventory/page.tsx",
    "src/app/staff/reconciliation/page.tsx",
    "src/app/staff/emails/page.tsx",
    "src/app/staff/catalog/page.tsx",
  ]) {
    assert.ok(PAGES.includes(expected), `audit missed ${expected}`);
  }
});

/**
 * Rows must never come from a result whose `error` was not consulted.
 *
 * `result.data ?? []` is the single expression behind every instance of this
 * defect in the codebase's history. The guarded form
 * `(result.error ? [] : (result.data ?? []))` is fine and is what the fixed
 * pages use, so the check looks for the *unguarded* one.
 */
test("no staff page turns an unchecked result into rows", () => {
  const offenders: string[] = [];
  for (const page of PAGES) {
    const code = readCode(page);
    // Strip the guarded form first, then look for what is left.
    const withoutGuarded = code.replace(
      /\w+\.error\s*\?\s*\[\]\s*:\s*\(?\s*\w+\.data\s*(?:\?\?|\|\|)\s*\[\]\s*\)?/g,
      "GUARDED"
    );
    if (/\.data\s*(\?\?|\|\|)\s*\[\]/.test(withoutGuarded)) offenders.push(page);
  }
  assert.deepEqual(
    offenders,
    [],
    `these pages derive rows from a result without checking .error, so a refused query renders as empty:\n${offenders.join("\n")}`
  );
});

/**
 * A raw provider message must not be rendered on a *load* path.
 *
 * Postgres errors name schema objects and, on a constraint violation, quote the
 * offending value — which on this schema can be an address or a private note.
 *
 * Scope, stated rather than implied: this covers the optional-chained form
 * (`result.error?.message`), which is what a loader produces when it did not
 * branch on the error first. Staff *write* paths in the catalog editor still
 * surface `insertError.message` directly — around fifteen call sites, all
 * pre-existing, all behind `catalog.manage`, and several genuinely actionable
 * ("duplicate slug"). Rewriting them is real work with real behaviour change
 * and is recorded as deferred rather than done halfway here.
 */
test("no staff page renders a raw Supabase error message on a load path", () => {
  const offenders = PAGES.filter((page) => /setError\((?:\w+\.)*\w*[eE]rror\?\.message/.test(readCode(page)));
  assert.deepEqual(offenders, [], `raw provider messages reach the page in:\n${offenders.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Page-specific fixes made in this pass
// ---------------------------------------------------------------------------

test("REGRESSION /staff/inventory does not show 'no products match' when the load failed", () => {
  const source = read("src/app/staff/inventory/page.tsx");
  assert.match(source, /loadFailed/, "the page must distinguish a failed load from an empty result");
  const index = source.indexOf("No products match this view.");
  assert.ok(index > 0, "the empty state should still exist for the genuinely-empty case");
  // The failure branch has to come first, or the empty state catches the failure.
  assert.ok(
    source.indexOf("loadFailed ?") < index,
    "the failure branch must be tested before the empty branch"
  );
});

test("REGRESSION /staff/inventory withholds its count rather than showing 0", () => {
  const source = read("src/app/staff/inventory/page.tsx");
  assert.match(source, /Count unavailable/, "an unknown total must not render as `0 products`");
});

test("REGRESSION /staff/emails cannot sit on a loading state for ever", () => {
  const source = read("src/app/staff/emails/page.tsx");
  // The old code was `fetch(...).then(...).then(...)` with no rejection path, so
  // a network failure never resolved into any visible state at all.
  assert.doesNotMatch(source, /void fetch\("\/api\/staff\/emails"\)\s*\n?\s*\.then/, "a fetch with no catch can hang the page for ever");
  assert.match(source, /catch \{/, "the load must have a rejection path");
  assert.match(source, /loadFailed/, "a failed load must be a distinct visible state");
});

test("REGRESSION the order detail timeline names the sources it is missing", () => {
  const source = read("src/app/staff/orders/[id]/page.tsx");
  assert.match(source, /missingTimelineSources/, "a timeline assembled from four sources must say which failed");
  // Payments and refunds are the two that change what a staff member believes
  // about money, so they must be named individually rather than as "some data".
  assert.match(source, /isFailed\(payments\) \? "payments"/);
  assert.match(source, /isFailed\(refunds\) \? "refunds"/);
});

test("REGRESSION the order detail email list distinguishes empty from failed", () => {
  const source = read("src/app/staff/orders/[id]/page.tsx");
  assert.match(source, /isTrulyEmpty\(emails\)/, "the 'no email attempts' line must require a successful query");
});

test("REGRESSION the catalog editor does not present a failed option read as no options", () => {
  const source = read("src/app/staff/catalog/page.tsx");
  assert.match(source, /editorLoadFailed/);
  // addGroup positions a new group at `groups.length`; adding to a list that
  // failed to load would collide with the options the product actually has.
  assert.match(
    source,
    /disabled=\{!canManage \|\| !draft\.is_custom \|\| editorLoadFailed\}/,
    "adding an option must be blocked while the existing options are unknown"
  );
});

test("REGRESSION the catalog publish checklist reports unknown rather than incomplete", () => {
  const source = read("src/app/staff/catalog/page.tsx");
  assert.match(source, /unknown: editorLoadFailed && draft\.is_custom/, "an unreadable option list is not a missing one");
  assert.match(source, /could not be checked/);
});

// ---------------------------------------------------------------------------
// The pages pass 9 already fixed must stay fixed
// ---------------------------------------------------------------------------

test("the dashboard still gates every derived value on a successful load", () => {
  const source = read("src/app/staff/page.tsx");
  assert.match(source, /ordersUsable/, "pass 9's guard must survive");
  assert.match(source, /orderResult\.error \? \[\] : /, "a refused query must clear the rows");
});

test("the fulfillment queue still withholds its bucket counts on failure", () => {
  const source = read("src/app/staff/fulfillment/page.tsx");
  assert.match(source, /result\.error \? \[\] : /);
});
