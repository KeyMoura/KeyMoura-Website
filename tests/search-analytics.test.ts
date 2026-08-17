import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_POSITION,
  MAX_QUERY_LENGTH,
  MAX_RESULT_COUNT,
  MAX_TOKENS,
  SEARCH_RESULT_TYPES,
  SEARCH_SOURCES,
  STORABLE_CLICK_TYPES,
  canStoreClick,
  isUuid,
  normalizeScope,
  validateClickEvent,
  validateSearchEvent,
} from "../src/lib/search/analytics.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Comments describe what was removed, so a `doesNotMatch` must not read them. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const eventRoute = read("src/app/api/public/search-event/route.ts");
const clickRoute = read("src/app/api/public/search-click/route.ts");
const track = read("src/lib/search/track.ts");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// Search events
// ---------------------------------------------------------------------------

const goodSearch = { source: "storefront-nav", query: "shift knob", scope: "all", resultCount: 5 };

test("a well-formed search event is accepted and normalized", () => {
  const result = validateSearchEvent(goodSearch);
  assert.ok(result.ok);
  assert.equal(result.value.rawQuery, "shift knob");
  assert.equal(result.value.normalizedQuery, "shift knob");
  assert.deepEqual(result.value.tokens, ["shift", "knob"]);
  assert.equal(result.value.scope, "all");
  assert.equal(result.value.resultCount, 5);
});

test("an invented source is refused rather than stored", () => {
  const result = validateSearchEvent({ ...goodSearch, source: "totally-made-up" });
  assert.equal(result.ok, false);
  // And the closed set is genuinely closed.
  assert.ok(!SEARCH_SOURCES.includes("totally-made-up" as never));
});

test("an empty query is not a search", () => {
  for (const query of ["", "   ", null, 42, undefined]) {
    assert.equal(validateSearchEvent({ ...goodSearch, query }).ok, false, `${String(query)} should be refused`);
  }
});

test("result counts are bounded, so a client cannot assert an arbitrary one", () => {
  assert.equal(validateSearchEvent({ ...goodSearch, resultCount: -1 }).ok, false);
  assert.equal(validateSearchEvent({ ...goodSearch, resultCount: MAX_RESULT_COUNT + 1 }).ok, false);
  assert.equal(validateSearchEvent({ ...goodSearch, resultCount: Number.NaN }).ok, false);
  assert.equal(validateSearchEvent({ ...goodSearch, resultCount: "5" }).ok, false);
  assert.equal(validateSearchEvent({ ...goodSearch, resultCount: MAX_RESULT_COUNT }).ok, true);
});

test("a query is truncated rather than stored at whatever length was sent", () => {
  const result = validateSearchEvent({ ...goodSearch, query: "a".repeat(5000) });
  assert.ok(result.ok);
  assert.equal(result.value.rawQuery.length, MAX_QUERY_LENGTH);
});

test("stored tokens are capped", () => {
  const result = validateSearchEvent({ ...goodSearch, query: Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") });
  assert.ok(result.ok);
  assert.ok(result.value.tokens.length <= MAX_TOKENS);
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test("scope accepts only the shapes the search itself produces", () => {
  assert.equal(normalizeScope("all"), "all");
  assert.equal(normalizeScope("products"), "products");
  assert.equal(normalizeScope("projects"), "projects");
  assert.equal(normalizeScope("category:shift-knobs"), "category:shift-knobs");
});

test("an unknown scope falls back to All rather than refusing the event", () => {
  // The search itself widens a stale bookmark to All, so the analytics must
  // record what actually happened rather than dropping an event the customer
  // experienced as an ordinary search.
  assert.equal(normalizeScope("category:../../etc/passwd"), "all");
  assert.equal(normalizeScope("category:" + "x".repeat(300)), "all");
  assert.equal(normalizeScope("<script>"), "all");
  assert.equal(normalizeScope(null), "all");
  assert.equal(normalizeScope(12), "all");
});

// ---------------------------------------------------------------------------
// Click events
// ---------------------------------------------------------------------------

const goodClick = {
  source: "projects",
  searchEventId: UUID_A,
  resultType: "project",
  resultId: UUID_B,
  position: 3,
  scope: "projects",
  query: "walnut",
};

test("a well-formed click is accepted", () => {
  const result = validateClickEvent(goodClick);
  assert.ok(result.ok);
  assert.equal(result.value.resultId, UUID_B);
  assert.equal(result.value.searchEventId, UUID_A);
  assert.equal(result.value.position, 3);
});

test("an arbitrary result id cannot be attached to behaviour", () => {
  // This is the field an attacker would use to make a chosen row accumulate
  // clicks, so it must be a uuid and — in the route — a row that really exists.
  for (const resultId of ["", "not-a-uuid", "1; drop table", 7, null, UUID_B.replace(/-/g, "")]) {
    assert.equal(validateClickEvent({ ...goodClick, resultId }).ok, false, `${String(resultId)} should be refused`);
  }
  assert.equal(isUuid(UUID_B), true);
});

test("an unknown result type is refused", () => {
  assert.equal(validateClickEvent({ ...goodClick, resultType: "invoice" }).ok, false);
  assert.equal(validateClickEvent({ ...goodClick, resultType: null }).ok, false);
  for (const type of SEARCH_RESULT_TYPES) {
    assert.equal(validateClickEvent({ ...goodClick, resultType: type }).ok, true);
  }
});

test("rank is bounded, because it feeds the position normalization", () => {
  assert.equal(validateClickEvent({ ...goodClick, position: -1 }).ok, false);
  assert.equal(validateClickEvent({ ...goodClick, position: MAX_POSITION + 1 }).ok, false);
  assert.equal(validateClickEvent({ ...goodClick, position: "3" }).ok, false);
  assert.equal(validateClickEvent({ ...goodClick, position: 0 }).ok, true);
  assert.equal(validateClickEvent({ ...goodClick, position: MAX_POSITION }).ok, true);
});

test("a malformed search-event reference is refused, not stored dangling", () => {
  assert.equal(validateClickEvent({ ...goodClick, searchEventId: "nope" }).ok, false);
  // Absent is fine: a click is still worth recording without its search.
  const result = validateClickEvent({ ...goodClick, searchEventId: null });
  assert.ok(result.ok);
  assert.equal(result.value.searchEventId, null);
});

test("only the result types the current schema can hold are storable", () => {
  assert.deepEqual([...STORABLE_CLICK_TYPES], ["project"]);
  assert.equal(canStoreClick("project"), true);
  // `info_search_click_events.clicked_page_id` is a foreign key into
  // `info_pages`, so a product id cannot be written there. Declined explicitly
  // rather than forced into a column that means something else; the migration
  // that generalizes the table is proposed in docs/search-architecture.md.
  assert.equal(canStoreClick("product"), false);
  assert.equal(canStoreClick("category"), false);
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

test("both analytics routes validate before they write", () => {
  for (const [name, source, validator] of [
    ["search-event", eventRoute, "validateSearchEvent"],
    ["search-click", clickRoute, "validateClickEvent"],
  ] as const) {
    const validateAt = source.indexOf(`${validator}(`);
    const insertAt = source.indexOf(".insert(");
    assert.ok(validateAt >= 0, `${name} must validate`);
    assert.ok(insertAt >= 0, `${name} must write`);
    assert.ok(validateAt < insertAt, `${name} must validate before writing`);
  }
});

test("both routes bound the body they will parse", () => {
  for (const source of [eventRoute, clickRoute]) {
    assert.match(source, /MAX_BODY_BYTES = [\d_]+/);
    assert.match(source, /text\.length > MAX_BODY_BYTES/);
  }
});

test("the click route checks the target row exists and is public", () => {
  // The foreign key would catch a fabricated id; it would not catch a real id
  // belonging to a row the public cannot see.
  assert.match(clickRoute, /\.from\("info_pages"\)/);
  assert.match(clickRoute, /\.eq\("status", "approved"\)/);
  assert.match(clickRoute, /reason: "unknown result"/);
});

test("the click route will not store a dangling search-event reference", () => {
  assert.match(clickRoute, /\.from\("info_search_events"\)[\s\S]{0,160}\.eq\("id", click\.searchEventId\)/);
});

test("analytics writes go through the server, never the browser's Supabase client", () => {
  // The browser inserts these replace were rejected by RLS for every customer:
  // the tables' only permissive policy requires `is_staff_user()`.
  assert.doesNotMatch(stripComments(track), /supabaseBrowser|from\(["']info_search/);
  assert.match(track, /\/api\/public\/search-event/);
  assert.match(track, /\/api\/public\/search-click/);
  // keepalive, or the click is cancelled by the navigation it precedes.
  assert.match(track, /keepalive: true/);
});

test("the storefront search and the projects index both record through the routes", () => {
  for (const path of ["src/components/nav/StorefrontSearch.tsx", "src/app/projects/ProjectsIndexClient.tsx"]) {
    const source = stripComments(read(path));
    assert.match(source, /trackSearch/, `${path} must record searches`);
    assert.match(source, /trackSearchClick/, `${path} must record clicks`);
    assert.doesNotMatch(
      source,
      /from\(["']info_search_(events|click_events)["']\)/,
      `${path} must not insert analytics from the browser`
    );
  }
});

test("no analytics failure can reach the customer", () => {
  // Every path in the client helper swallows; every route path returns 2xx.
  assert.match(track, /catch \{/);
  assert.doesNotMatch(stripComments(track), /throw /);
  for (const source of [eventRoute, clickRoute]) {
    assert.doesNotMatch(stripComments(source), /status: 5\d\d/);
  }
});

test("the click-boost read is aggregated on the server and reveals nothing", () => {
  // `/projects` ranks in the browser, so it needs the behavioural signal there.
  // It used to `select` the raw click table with the anon key, which RLS refuses
  // for every customer — so the relevance learning never ran. The aggregation
  // moved to a route; what crosses the wire is a bounded weight per public
  // project, and nothing else.
  const weights = read("src/app/api/public/search-weights/route.ts");
  assert.match(weights, /clickBoost\(/, "the same capped function the ranker uses");
  assert.match(weights, /\.eq\("status", "approved"\)/, "only publicly visible projects");
  assert.match(weights, /supabaseAdmin/, "aggregated with the service role, not the browser's key");

  // The response body must carry weights and nothing identifying.
  const returned = weights.match(/NextResponse\.json\(\{[^}]*\}\)/g) ?? [];
  assert.ok(returned.length > 0);
  for (const shape of returned) {
    assert.doesNotMatch(shape, /quer(y|ies)|user|session|token|raw_query|clicks|created_at/i, shape);
  }
});
