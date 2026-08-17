import assert from "node:assert/strict";
import test from "node:test";

import {
  CLICK_BOOST_MAX,
  CLICK_MIN_IMPRESSIONS,
  FIELD_WEIGHT_MAX,
  MAX_REFINEMENT,
  MIN_FUZZY_TOKEN_LENGTH,
  TIER_BASE,
  clickBoost,
  editSimilarity,
  foldPlural,
  fuzzyMatch,
  normalizeForSearch,
  rankCandidates,
  scoreCandidate,
  searchTokens,
  trigramSimilarity,
  trigrams,
  type ClickStat,
  type SearchCandidate,
} from "../src/lib/search/relevance.ts";

/**
 * The ranking rules, asserted as rules rather than as numbers.
 *
 * Most of these check an *ordering* or an *invariant* — "exact beats fuzzy",
 * "no amount of clicking crosses a tier" — rather than a specific score, so
 * tuning the weights inside a tier does not break the suite while the
 * guarantees it exists to protect stay guarded.
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("the plural fold reaches a plural category from a singular query, and no further", () => {
  assert.equal(foldPlural("shift knobs"), "shift knob");
  assert.equal(foldPlural("cutting boards"), "cutting board");
  assert.equal(foldPlural("boxes"), "box");
  // Words that merely end in s are left alone, so it cannot invent equalities.
  assert.equal(foldPlural("glass"), "glass");
  assert.equal(foldPlural("brass"), "brass");
  assert.equal(foldPlural("cnc"), "cnc");
});

test("normalization folds case, accents, and the separators people type", () => {
  assert.equal(normalizeForSearch("Shift-Knob"), "shift knob");
  assert.equal(normalizeForSearch("shift_knob"), "shift knob");
  assert.equal(normalizeForSearch("  Shift   Knob  "), "shift knob");
  assert.equal(normalizeForSearch("Ébauche"), "ebauche");
  // Punctuation a product name really carries: 10x14" survives as two tokens.
  assert.deepEqual(searchTokens('Cutting Board 10x14"'), ["cutting", "board", "10x14"]);
  assert.equal(normalizeForSearch(null), "");
});

// ---------------------------------------------------------------------------
// Trigrams — the contract with pg_trgm
// ---------------------------------------------------------------------------

test("trigrams reproduce what postgres show_trgm() returns", () => {
  // `select show_trgm('word')` => {"  w"," wo",ord,"rd ",wor}
  assert.deepEqual([...trigrams("word")].sort(), ["  w", " wo", "ord", "rd ", "wor"].sort());
});

test("trigram similarity is shared-over-union, like pg_trgm.similarity()", () => {
  assert.equal(trigramSimilarity("word", "word"), 1);
  assert.equal(trigramSimilarity("", "word"), 0);
  // braket/bracket: 5 shared of 10 union.
  assert.ok(Math.abs(trigramSimilarity("braket", "bracket") - 0.5) < 1e-9);
});

// ---------------------------------------------------------------------------
// Typo tolerance — the cases the brief names
// ---------------------------------------------------------------------------

test("the three typo examples from the brief are all tolerated", () => {
  for (const [typed, intended] of [
    ["braket", "bracket"],
    ["machning", "machining"],
    ["walunt", "walnut"],
  ] as const) {
    assert.ok(fuzzyMatch(typed, intended).matched, `${typed} should match ${intended}`);
  }
});

test("walunt/walnut is caught by the edit measure, not the trigram one", () => {
  // Recorded because it is the reason two measures exist: a transposition is
  // almost invisible to trigrams. If a future change drops the edit measure
  // this test says exactly what breaks.
  assert.ok(trigramSimilarity("walunt", "walnut") < 0.3, "trigram alone would miss it");
  assert.ok(editSimilarity("walunt", "walnut") >= 0.7, "the edit measure catches it");
});

test("short queries get no fuzzy matching at all", () => {
  // cnc and cad are one edit apart and both are real terms this shop uses.
  assert.equal(fuzzyMatch("cnc", "cad").matched, false);
  assert.ok("cnc".length < MIN_FUZZY_TOKEN_LENGTH);
});

// ---------------------------------------------------------------------------
// Tier ordering
// ---------------------------------------------------------------------------

const product = (over: Partial<SearchCandidate> & { id: string; title: string }): SearchCandidate => ({
  tags: [],
  slug: null,
  body: null,
  updatedAt: null,
  ...over,
});

test("an exact name beats a prefix, which beats a token, which beats the body", () => {
  const exact = scoreCandidate(product({ id: "a", title: "Shift Knob" }), "shift knob");
  const prefix = scoreCandidate(product({ id: "b", title: "Shift Knob Adapter Kit" }), "shift knob");
  const someToken = scoreCandidate(product({ id: "c", title: "Knob Blank" }), "shift knob");
  const body = scoreCandidate(
    product({ id: "d", title: "Pedal Spacer", body: "pairs well with a shift knob and a knob collar" }),
    "shift knob"
  );

  assert.equal(exact.tier, "exact");
  assert.equal(prefix.tier, "prefix");
  assert.equal(someToken.tier, "someTokens");
  assert.equal(body.tier, "body");
  assert.ok(exact.score > prefix.score);
  assert.ok(prefix.score > someToken.score);
  assert.ok(someToken.score > body.score);
});

test("an exact match beats a fuzzy match no matter how the fuzzy one is dressed up", () => {
  const exact = scoreCandidate(product({ id: "a", title: "Bracket" }), "bracket");
  const fuzzy = scoreCandidate(
    product({
      id: "b",
      title: "Braket",
      tags: ["braket", "braket", "braket"],
      slug: "braket",
      body: "braket braket braket braket braket",
      updatedAt: new Date().toISOString(),
    }),
    "bracket"
  );
  assert.equal(exact.tier, "exact");
  assert.equal(fuzzy.tier, "fuzzy");
  assert.ok(exact.score > fuzzy.score);
});

test("a prefix beats a weak fuzzy match", () => {
  const prefix = scoreCandidate(product({ id: "a", title: "Machining Fixture Plate" }), "machining");
  const weakFuzzy = scoreCandidate(product({ id: "b", title: "Machning" }), "machining");
  assert.equal(prefix.tier, "prefix");
  assert.equal(weakFuzzy.tier, "fuzzy");
  assert.ok(prefix.score > weakFuzzy.score);
});

// ---------------------------------------------------------------------------
// Weighted tags — the "shift knob" rule
// ---------------------------------------------------------------------------

test("a canonical tag match outranks a description that merely mentions the words", () => {
  // The example the brief gives: searching "shift knob" must favour the product
  // filed under Shift Knobs over one whose description happens to say it.
  const tagged = product({ id: "tagged", title: "Billet Ball Top", tags: ["Shift Knobs"] });
  const mentioned = product({
    id: "mentioned",
    title: "Pedal Spacer Set",
    body: "Sits beside your shift knob. Matches any shift knob finish. Shift knob not included.",
  });

  const ranked = rankCandidates([mentioned, tagged], "shift knob");
  assert.equal(ranked[0].candidate.id, "tagged");
  assert.equal(ranked[0].tier, "tagExact");
  assert.equal(ranked[1].tier, "body");
});

test("a curated tag hit outranks a slug hit for the same coverage", () => {
  const byTag = scoreCandidate(product({ id: "a", title: "Ball Top", tags: ["walnut"] }), "walnut");
  const bySlug = scoreCandidate(product({ id: "b", title: "Ball Top", slug: "walnut-ball" }), "walnut");
  assert.equal(byTag.tier, "tagExact");
  assert.equal(bySlug.tier, "tagToken");
  assert.ok(byTag.score > bySlug.score);
});

// ---------------------------------------------------------------------------
// Click feedback — the anti-runaway safeguards
// ---------------------------------------------------------------------------

test("click boost needs a minimum sample before it counts for anything", () => {
  const belowSample: ClickStat = { impressions: CLICK_MIN_IMPRESSIONS - 1, clicks: CLICK_MIN_IMPRESSIONS - 1 };
  assert.equal(clickBoost(belowSample), 0);
  assert.equal(clickBoost(null), 0);
  assert.equal(clickBoost({ impressions: 500, clicks: 0 }), 0);
});

test("click boost is a capped ratio, so more clicks cannot buy more rank", () => {
  const many = clickBoost({ impressions: 1_000_000, clicks: 1_000_000, averagePosition: 20 });
  const some = clickBoost({ impressions: 100, clicks: 100, averagePosition: 20 });
  assert.ok(many <= CLICK_BOOST_MAX);
  assert.ok(some <= CLICK_BOOST_MAX);
  // A perfect rate saturates: the millionth click is worth what the hundredth was.
  assert.equal(many, some);
});

test("a click at the top of the list is discounted against a click from further down", () => {
  const atTop = clickBoost({ impressions: 100, clicks: 50, averagePosition: 0 });
  const fromDeep = clickBoost({ impressions: 100, clicks: 50, averagePosition: 12 });
  assert.ok(fromDeep > atTop, "choosing something buried is stronger evidence than clicking what was already first");
});

test("no amount of click analytics can lift a result across a tier", () => {
  // The runaway-popularity guard, stated as arithmetic: the whole refinement
  // band is smaller than the gap between two tiers, and the click share is a
  // fraction of that band.
  assert.ok(MAX_REFINEMENT < TIER_BASE.exact - TIER_BASE.prefix);
  assert.ok(CLICK_BOOST_MAX + FIELD_WEIGHT_MAX <= MAX_REFINEMENT + CLICK_BOOST_MAX);

  const adored: ClickStat = { impressions: 100_000, clicks: 100_000, averagePosition: 50 };
  const bodyOnlyButAdored = scoreCandidate(
    product({ id: "adored", title: "Unrelated Thing", body: "walnut" }),
    "walnut",
    adored
  );
  const exactAndIgnored = scoreCandidate(product({ id: "plain", title: "Walnut" }), "walnut");

  assert.equal(bodyOnlyButAdored.tier, "body");
  assert.equal(exactAndIgnored.tier, "exact");
  assert.ok(
    exactAndIgnored.score > bodyOnlyButAdored.score,
    "a result nobody clicks but which exactly matches must still win"
  );
  assert.ok(bodyOnlyButAdored.clickBoost <= CLICK_BOOST_MAX);
});

test("click stats reorder results only inside a tier", () => {
  const a = product({ id: "a", title: "Walnut Board One" });
  const b = product({ id: "b", title: "Walnut Board Two" });
  const stats = new Map<string, ClickStat>([["b", { impressions: 200, clicks: 180, averagePosition: 4 }]]);

  const withStats = rankCandidates([a, b], "walnut board", stats);
  const withoutStats = rankCandidates([a, b], "walnut board");

  assert.equal(withStats[0].candidate.id, "b", "behaviour breaks the tie");
  assert.equal(withoutStats[0].candidate.id, "a", "and supplies no tie-break of its own when absent");
  assert.equal(withStats[0].tier, withStats[1].tier, "both are still in the same tier");
});

// ---------------------------------------------------------------------------
// General shape
// ---------------------------------------------------------------------------

test("non-matching candidates are dropped rather than ranked last", () => {
  const ranked = rankCandidates(
    [product({ id: "a", title: "Walnut Board" }), product({ id: "b", title: "Aluminium Bracket" })],
    "walnut"
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].candidate.id, "a");
});

test("an empty query ranks nothing rather than everything", () => {
  assert.equal(rankCandidates([product({ id: "a", title: "Walnut Board" })], "   ").length, 0);
});

test("ties fall back to the order the caller supplied", () => {
  // The catalog hands rows over in `sort_order`, which is the merchandising
  // order the shop chose; a tie must not shuffle it.
  const rows = [
    product({ id: "first", title: "Board" }),
    product({ id: "second", title: "Board" }),
    product({ id: "third", title: "Board" }),
  ];
  assert.deepEqual(
    rankCandidates(rows, "board").map((entry) => entry.candidate.id),
    ["first", "second", "third"]
  );
});
