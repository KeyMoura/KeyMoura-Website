import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  availableDestinations,
  DESTINATIONS,
  fieldMatchesToken,
  itemHref,
  KIND_ORDER,
  rankSearchItems,
  suggestTerm,
  tokenize,
  type SearchItem,
} from "../src/lib/siteSearch.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const palette = read("src/components/CommandPalette.tsx");
const helpDialog = read("src/components/ui/SearchHelpDialog.tsx");

const product: SearchItem = {
  kind: "product",
  id: "p1",
  title: "Ball Type Shift Knob",
  slug: "ball-shift-knob",
  category: "Knobs",
  summary: "Turned aluminum shift knob",
  updatedAt: "2026-08-01T00:00:00Z",
};
const project: SearchItem = {
  kind: "project",
  id: "j1",
  title: "Machined Aluminum Enclosure",
  slug: "machined-aluminum-enclosure",
  category: "Enclosures",
  platform: "bench",
  tags: ["aluminum", "cnc"],
  body: "Notes about anodizing the finished enclosure.",
  updatedAt: "2026-07-30T00:00:00Z",
};
const thread: SearchItem = {
  kind: "thread",
  id: "1",
  title: "Best finish for outdoor brackets",
  slug: "best-finish-outdoor-brackets",
  categorySlug: "finishing",
  categoryName: "Finishing",
  replyCount: 12,
  isPinned: false,
  isLocked: false,
  updatedAt: "2026-07-29T00:00:00Z",
};
const corpus = [product, project, thread];

// --- ranking -------------------------------------------------------------

test("search covers catalog products, projects, and community threads", () => {
  assert.equal(rankSearchItems(corpus, "shift knob", []).length, 1);
  assert.equal(rankSearchItems(corpus, "enclosure", [])[0].item.kind, "project");
  assert.equal(rankSearchItems(corpus, "brackets", [])[0].item.kind, "thread");
});

test("non-matching items are dropped instead of padding the result list", () => {
  assert.deepEqual(rankSearchItems(corpus, "wholly-unrelated-term", []).map((entry) => entry.item.id), []);
});

test("titles outrank body text", () => {
  const ranked = rankSearchItems(corpus, "aluminum", []);
  assert.equal(ranked[0].item.id, project.id);
});

test("chips and typed text both contribute to the score", () => {
  const withChip = rankSearchItems(corpus, "", ["enclosure"]);
  assert.equal(withChip[0].item.id, project.id);
  const both = rankSearchItems(corpus, "aluminum", ["enclosure"]);
  assert.equal(both[0].matchedTokens, 2);
});

test("an empty query groups by kind then recency", () => {
  const ranked = rankSearchItems(corpus, "", []).map((entry) => entry.item.kind);
  const positions = ranked.map((kind) => KIND_ORDER.indexOf(kind));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("a single-character typo still matches", () => {
  assert.equal(fieldMatchesToken("enclosure", "enclosur"), true);
  assert.equal(fieldMatchesToken("enclosure", "zzzzzzzz"), false);
});

test("tokenize splits and lowercases", () => {
  assert.deepEqual(tokenize("  CNC  Enclosure "), ["cnc", "enclosure"]);
  assert.deepEqual(tokenize("   "), []);
});

test("suggestions only fire for a genuinely close miss", () => {
  assert.equal(suggestTerm(corpus, "finishng"), "Finishing", "a one-letter miss is corrected");
  assert.equal(suggestTerm(corpus, "aluminum"), null, "an exact hit needs no correction");
  assert.equal(suggestTerm(corpus, "qq"), null, "too short to correct");
  assert.equal(suggestTerm(corpus, "zzzzzzzzzzzz"), null, "nothing close enough");
});

// --- routes and permissions ---------------------------------------------

test("results link to canonical routes", () => {
  assert.equal(itemHref(product), "/catalog/ball-shift-knob");
  assert.equal(itemHref(project), "/projects/machined-aluminum-enclosure", "Projects is canonical, not /info");
  assert.equal(itemHref(thread), "/community/finishing/best-finish-outdoor-brackets");
  assert.ok(!palette.includes("/info/"), "the palette must not route to the legacy /info prefix");
});

test("account destinations are withheld from signed-out visitors", () => {
  const signedOut = availableDestinations(false).map((item) => item.href);
  for (const guarded of ["/orders", "/account", "/messages", "/notifications"]) {
    assert.ok(!signedOut.includes(guarded), `${guarded} must not be offered when signed out`);
  }

  const signedIn = availableDestinations(true).map((item) => item.href);
  for (const guarded of ["/orders", "/account", "/messages", "/notifications"]) {
    assert.ok(signedIn.includes(guarded), `${guarded} should be reachable when signed in`);
  }
  assert.ok(signedOut.includes("/catalog") && signedOut.includes("/projects"));
});

test("no private record is ever placed in the search index", () => {
  // Destinations are links only; they carry no order or message content.
  for (const destination of DESTINATIONS) {
    assert.equal(typeof destination.href, "string");
    assert.ok(!("body" in destination), "destinations must not carry record content");
  }
  // The palette queries only publicly readable tables.
  for (const table of ["orders", "order_messages", "dm_messages", "notifications", "profiles"]) {
    assert.ok(!palette.includes(`from("${table}")`), `palette must not query ${table}`);
  }
  for (const table of ["products", "info_pages", "forum_threads", "forum_categories"]) {
    assert.ok(palette.includes(`from("${table}")`), `palette should query ${table}`);
  }
});

test("published-only filters are applied to indexed content", () => {
  assert.match(palette, /\.eq\("status", "approved"\)/);
  assert.match(palette, /\.eq\("is_published", true\)/);
  assert.match(palette, /\.is\("archived_at", null\)/);
  assert.match(palette, /\.eq\("is_deleted", false\)/);
});

// --- interaction behavior ------------------------------------------------

test("an outside click closes the search menu", () => {
  assert.match(palette, /rootRef\.current && !rootRef\.current\.contains\(target\)\) closeAll\(\)/);
  assert.match(palette, /window\.addEventListener\("mousedown", onPointerDown\)/);
});

test("an outside click never closes the help panel on its own", () => {
  // The only outside-click handler closes everything together; there is no
  // separate listener that dismisses the help panel alone.
  assert.equal((palette.match(/mousedown/g) ?? []).length, 2, "exactly one mousedown listener, added and removed");
  assert.ok(
    !/helpRef/.test(palette),
    "an outside-click ref scoped to the help panel would close it on clicks inside the search interface"
  );
});

test("the help icon toggles the panel and reports its state", () => {
  assert.match(palette, /onClick=\{\(\) => setHelpOpen\(\(value\) => !value\)\}/);
  assert.match(palette, /aria-expanded=\{helpOpen\}/);
  assert.match(palette, /aria-controls="search-help-panel"/);
});

test("Got it closes the help panel and returns focus to the icon", () => {
  assert.match(palette, /setHelpOpen\(false\);\s*\n\s*helpButtonRef\.current\?\.focus\(\);/);
  assert.match(palette, /Got it/);
});

test("Escape unwinds the help panel before the search menu", () => {
  assert.match(palette, /if \(helpOpen\) setHelpOpen\(false\);\s*\n\s*else setOpen\(false\);/);
});

test("opening and closing restores focus and never leaves a scroll lock", () => {
  assert.match(palette, /restoreFocusRef\.current = document\.activeElement/);
  assert.match(palette, /restoreFocusRef\.current\?\.focus\?\.\(\)/);
  assert.match(palette, /document\.body\.style\.overflow = "hidden"/);
  assert.match(palette, /document\.body\.style\.overflow = previous/);
});

test("the palette is announced as a dialog with keyboard result navigation", () => {
  assert.match(palette, /role="dialog"/);
  assert.match(palette, /aria-modal="true"/);
  assert.match(palette, /aria-label="Search this site"/);
  assert.match(palette, /ArrowDown/);
  assert.match(palette, /ArrowUp/);
  assert.match(palette, /aria-live="polite"/);
});

test("search help says only what the search actually does", () => {
  const start = palette.indexOf('id="search-help-panel"');
  const end = palette.indexOf('data-testid="search-help-dismiss"');
  assert.ok(start > 0 && end > start, "could not locate the help panel markup");
  const help = palette.slice(start, end);

  for (const area of ["Catalog", "Projects", "Community threads"]) {
    assert.ok(help.includes(area), `help should name the ${area} area`);
  }
  // The palette implements chips and fuzzy substring matching, nothing more.
  // Advertising field or boolean syntax it does not support would be a lie.
  for (const unsupported of ["AND ", " OR ", "tag:", "site:", "title:", "NOT ", "-exclude", "wildcard", "regex"]) {
    assert.ok(!help.includes(unsupported), `help must not imply unsupported syntax: ${unsupported}`);
  }
});

test("the shared page-level help dialog keeps outside clicks harmless", () => {
  assert.ok(!helpDialog.includes("mousedown"), "no outside-click dismissal");
  assert.match(helpDialog, /Got it/);
  assert.match(helpDialog, /event\.key === "Escape"/);
  assert.match(helpDialog, /restoreRef\.current\?\.focus\?\.\(\)/);
  assert.match(helpDialog, /aria-modal="true"/);
});

test("every search surface uses the shared help dialog", () => {
  for (const page of [
    "src/app/community/page.tsx",
    "src/app/community/[slug]/page.tsx",
    "src/app/info/InfoIndexClient.tsx",
    "src/app/info/category/[slug]/page.tsx",
  ]) {
    const source = read(page);
    assert.match(source, /SearchHelpDialog/, `${page} should use the shared dialog`);
    assert.ok(!source.includes("Chips (comma-separated terms)"), `${page} still inlines a duplicated help panel`);
  }
});
