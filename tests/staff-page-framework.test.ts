import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ORDER_TAB_ALIASES,
  attentionSeverity,
  availableTabs,
  resolveTab,
  resolveTabWithAliases,
  stateLabel,
  stateText,
  stateTone,
  type StaffTab,
} from "../src/lib/staff/pageFramework.ts";

/**
 * The staff page framework.
 *
 * Before this pass every staff page built its own chrome: `/staff/orders`
 * opened with an accent eyebrow reading "Today", `/staff/settings/commerce`
 * with one reading "Commerce", `/staff/catalog` with the same word on a page in
 * a different section. Seven pages shared a stylesheet and nothing else.
 *
 * These assert the *rules* the framework enforces, not the pixels. The tab
 * resolution and the status vocabulary are pure functions precisely so they can
 * be checked here rather than only by rendering.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const TABS: StaffTab[] = [
  { id: "overview", label: "Overview" },
  { id: "items", label: "Items" },
  { id: "production", label: "Production", available: false },
  { id: "activity", label: "Activity" },
];

// ---------------------------------------------------------------------------
// Tab resolution
// ---------------------------------------------------------------------------

test("an unavailable tab is dropped rather than disabled", () => {
  // A tab that refuses when pressed teaches a staff member to distrust the
  // whole strip.
  assert.deepEqual(
    availableTabs(TABS).map((tab) => tab.id),
    ["overview", "items", "activity"]
  );
});

test("an unknown or unavailable request falls back to the first available tab", () => {
  assert.equal(resolveTab(TABS, null), "overview");
  assert.equal(resolveTab(TABS, "nonsense"), "overview");
  /*
   * The case that matters: `/staff/orders/<id>#production` is linked from the
   * dashboard, the production queue and the fulfillment queue. A viewer without
   * `production.view` following one of those links must land on a page, not on
   * an empty frame.
   */
  assert.equal(resolveTab(TABS, "production"), "overview");
  assert.equal(resolveTab(TABS, "items"), "items");
});

test("a leading hash and stray case are tolerated", () => {
  assert.equal(resolveTab(TABS, "#Items"), "items");
  assert.equal(resolveTab(TABS, "  #ACTIVITY "), "activity");
});

test("an empty tab set resolves to null rather than to a guess", () => {
  // "there is nothing to show" and "show the first thing" are different
  // answers, and a caller has to be able to tell them apart.
  assert.equal(resolveTab([], "overview"), null);
  assert.equal(resolveTab([{ id: "a", label: "A", available: false }], "a"), null);
});

test("retired order anchors resolve to the tabs that replaced them", () => {
  /*
   * The order workspace's sections were reachable by anchor before this pass,
   * and those anchors are linked from three other pages. Turning the sections
   * into tabs without this table would have broken every one of them: the link
   * would still resolve, land on Overview, and the reader would conclude the
   * thing they clicked through for was gone.
   */
  const orderTabs: StaffTab[] = [
    { id: "overview", label: "Overview" },
    { id: "items", label: "Items" },
    { id: "payment", label: "Payment" },
    { id: "production", label: "Production" },
    { id: "fulfillment", label: "Fulfillment" },
    { id: "messages", label: "Messages" },
    { id: "returns", label: "Returns" },
    { id: "activity", label: "Activity" },
  ];
  const cases: Record<string, string> = {
    "#conversation": "messages",
    "#quote": "payment",
    "#shop-work": "production",
    "#customer-review-package": "production",
    "#fulfillment": "fulfillment",
    "#activity": "activity",
  };
  for (const [hash, expected] of Object.entries(cases)) {
    assert.equal(
      resolveTabWithAliases(orderTabs, hash, ORDER_TAB_ALIASES),
      expected,
      `${hash} must still reach ${expected}`
    );
  }
});

test("every order alias points at a tab the workspace actually renders", () => {
  const page = read("src/app/staff/orders/[id]/page.tsx");
  for (const target of new Set(Object.values(ORDER_TAB_ALIASES))) {
    assert.match(
      page,
      new RegExp(`<TabPanel id="${target}"`),
      `the alias table points at "${target}", which the workspace does not render`
    );
  }
});

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

test("one state means one colour, everywhere", () => {
  /*
   * `/staff/orders` tinted payment states one way, the order page another, and
   * the fulfillment queue a third, so a staff member who learned that green
   * means settled learned nothing that transferred.
   */
  assert.equal(stateTone("paid"), "success");
  assert.equal(stateTone("delivered"), "success");
  assert.equal(stateTone("completed"), "success");
  assert.equal(stateTone("refund_failed"), "danger");
  assert.equal(stateTone("blocked"), "danger");
  assert.equal(stateTone("unpaid"), "warning");
  assert.equal(stateTone("requested"), "warning");
  assert.equal(stateTone("in_progress"), "accent");
  assert.equal(stateTone("draft"), "neutral");
});

test("an unknown state is neutral rather than alarming", () => {
  // A column that grows a value this table has not seen must not render it as
  // a failure just because nobody has filed it yet.
  assert.equal(stateTone("something_new"), "neutral");
  assert.equal(stateTone(null), "neutral");
  assert.equal(stateTone(undefined), "neutral");
});

test("state labels are sentence case, not Title Case", () => {
  assert.equal(stateLabel("in_progress"), "In progress");
  assert.equal(stateLabel("awaiting_payment"), "Awaiting payment");
  assert.equal(stateLabel(""), "");
});

test("the states whose plain label would mislead are overridden", () => {
  // "Customer review" is a quote review, and "Final review" is the customer
  // looking at the finished object. Neither is guessable from the column.
  assert.equal(stateText("customer_review"), "Quote review");
  assert.equal(stateText("final_review"), "Finished-product review");
  assert.equal(stateText("not_required"), "No delivery needed");
  assert.equal(stateText("ready_to_fulfill"), "Ready to ship");
});

test("attention severity is derived from the weight the queue already assigns", () => {
  /*
   * Derived rather than a second switch statement listing every `AttentionKind`
   * again — that duplicate is what drifts. A cancellation (100) is critical, an
   * unfulfilled order (60) is a warning, a delivery to confirm (40) is not.
   */
  assert.equal(attentionSeverity(100), "critical");
  assert.equal(attentionSeverity(90), "critical");
  assert.equal(attentionSeverity(60), "warning");
  assert.equal(attentionSeverity(40), "info");
});

// ---------------------------------------------------------------------------
// The framework's own structure
// ---------------------------------------------------------------------------

test("Section draws no border, so card-in-card cannot happen by accident", () => {
  const framework = read("src/components/staff/StaffPage.tsx");
  /*
   * The nesting rule. Grouping is done with a heading and whitespace; a border
   * is added only by wrapping content in `Card`, which `Section` never does for
   * you. Producing a card inside a card inside a card requires deliberately
   * nesting two `Card`s.
   */
  assert.match(framework, /className=\{cx\("staff-section", className\)\}/);
  assert.doesNotMatch(framework, /className=\{cx\("staff-section ui-card"/);
  const css = read("src/app/globals.css");
  assert.match(css, /\.staff-section \{ display: flex; flex-direction: column;/);
  assert.doesNotMatch(css, /\.staff-section \{[^}]*border:/);
});

test("tabs carry real tablist semantics and a roving tabindex", () => {
  const framework = read("src/components/staff/StaffPage.tsx");
  assert.match(framework, /role="tablist"/);
  assert.match(framework, /role="tab"/);
  assert.match(framework, /role="tabpanel"/);
  assert.match(framework, /aria-selected=\{active\}/);
  assert.match(framework, /aria-controls=\{`staff-tabpanel-\$\{tab\.id\}`\}/);
  // One tab stop for the whole strip, then arrow keys — the pattern a screen
  // reader announces as a tab list rather than as N unrelated buttons.
  assert.match(framework, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(framework, /ArrowRight/);
  assert.match(framework, /ArrowLeft/);
});

test("a failure is announced and never falls back to an empty state", () => {
  const framework = read("src/components/staff/StaffPage.tsx");
  assert.match(framework, /export function ErrorState/);
  assert.match(framework, /Notice tone="danger" role="alert"/);
  // Loading is announced too, rather than being a silent blank.
  assert.match(framework, /export function LoadingState/);
  assert.match(framework, /EmptyState role="status"/);
});

test("a status chip is not colour-only", () => {
  const framework = read("src/components/staff/StaffPage.tsx");
  // The chip always renders its wording; the tone is decoration on top of a
  // word, never the only carrier of the meaning.
  assert.match(framework, /const text = label \?\? stateText\(value\)/);
  assert.match(framework, /if \(!text\) return null/);
});

// ---------------------------------------------------------------------------
// The email split
// ---------------------------------------------------------------------------

test("email is three tabs, not one giant page", () => {
  const page = read("src/app/staff/emails/page.tsx");
  /*
   * It was five stacked sections plus a *separate route* for the delivery log,
   * so the two halves of one question — what does this message say, and did it
   * arrive — lived a menu click apart.
   */
  for (const id of ["templates", "deliveries", "settings"]) {
    assert.match(page, new RegExp(`<TabPanel id="${id}"`), `no panel for the ${id} tab`);
  }
  assert.match(page, /<EmailDeliveryCenter \/>/);
});

test("the delivery log route redirects rather than 404s", () => {
  // It is linked from the ledger, from staff bookmarks and from the sidebar's
  // `alsoOwns` entry. A consolidated route that 404s is worse than the split it
  // replaced.
  const route = read("src/app/staff/emails/deliveries/page.tsx");
  assert.match(route, /redirect\("\/staff\/emails#deliveries"\)/);
  assert.match(read("src/lib/staffNavigation.ts"), /alsoOwns: \["\/staff\/emails\/deliveries"\]/);
});

test("email has one save, and the test send is not it", () => {
  const page = read("src/app/staff/emails/page.tsx");
  assert.equal((page.match(/type="submit"/g) ?? []).length, 1);
  // "Send test" defaulting to submit would have saved every template as a side
  // effect of sending one test message.
  assert.match(page, /className="ui-btn ui-btn-secondary mt-4 text-sm" type="button" onClick=\{test\}/);
});

test("a template preview shows an unsupplied variable rather than hiding it", () => {
  const page = read("src/app/staff/emails/page.tsx");
  /*
   * The page had no preview at all: a staff member editing `{{order_total}}`
   * into a sentence could not see the sentence. A preview that silently dropped
   * an unsupplied variable would show a tidier message than the customer gets,
   * which is the surprise the preview exists to remove.
   */
  assert.match(page, /function previewText/);
  assert.match(page, /\[no \$\{name\}\]/);
});

// ---------------------------------------------------------------------------
// Page-level consistency across the redesigned surfaces
// ---------------------------------------------------------------------------

const REDESIGNED_PAGES = [
  "src/app/staff/page.tsx",
  "src/app/staff/orders/page.tsx",
  "src/app/staff/orders/[id]/page.tsx",
  "src/app/staff/production/page.tsx",
  "src/app/staff/production/[id]/page.tsx",
  "src/app/staff/fulfillment/page.tsx",
  "src/app/staff/catalog/page.tsx",
  "src/app/staff/catalog/categories/page.tsx",
  "src/app/staff/catalog/discounts/page.tsx",
  "src/app/staff/inventory/page.tsx",
  "src/app/staff/emails/page.tsx",
  "src/app/staff/settings/page.tsx",
  "src/app/staff/settings/commerce/page.tsx",
];

test("every redesigned staff page uses the shared page root", () => {
  for (const path of REDESIGNED_PAGES) {
    assert.match(read(path), /<StaffPage>/, `${path} does not use StaffPage`);
  }
});

test("no staff page nests a second width container inside the shell", () => {
  /*
   * `/staff/production`, `/staff/catalog/categories` and
   * `/staff/catalog/discounts` each wrapped themselves in `page-container`,
   * *inside* the staff shell's own `page-container-wide`. They rendered
   * measurably narrower than their neighbours in the same menu group, with
   * gutters that did not line up.
   */
  for (const path of REDESIGNED_PAGES) {
    const source = read(path);
    assert.doesNotMatch(source, /className="page-container[^"]*"/, `${path} nests a second width container`);
  }
});

test("the old per-page eyebrow is gone from the redesigned pages", () => {
  // Three different conventions were in use — "Today", "Commerce", "Settings" —
  // and the breadcrumb above already answers which section this is.
  for (const path of REDESIGNED_PAGES) {
    assert.doesNotMatch(read(path), /ui-eyebrow/, `${path} still renders a page eyebrow`);
  }
});

test("each redesigned page has exactly one h1, supplied by PageHeader", () => {
  const framework = read("src/components/staff/StaffPage.tsx");
  assert.match(framework, /<h1 className="staff-page-title">/);
  for (const path of REDESIGNED_PAGES) {
    const source = read(path);
    const inlineH1s = (source.match(/<h1[\s>]/g) ?? []).length;
    // The two record pages own their header markup because it carries state
    // chips and a next action; every other page gets its h1 from PageHeader.
    const allowed = path.includes("[id]") ? 1 : 0;
    assert.ok(
      inlineH1s <= allowed,
      `${path} renders ${inlineH1s} inline <h1> elements; expected at most ${allowed}`
    );
  }
});
