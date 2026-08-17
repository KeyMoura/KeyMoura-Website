/**
 * How search results are ordered.
 *
 * ## Why this is one module and not three
 *
 * Before this file, three surfaces ranked results and no two agreed. The
 * `/projects` index scored `title 12 / slug 8 / tag 10 / content 4` in the
 * browser; the command palette scored `title 14 / slug 8 / category 7 /
 * summary 5` in `siteSearch.ts`; and the navbar's suggestion endpoint did not
 * rank at all — it took whatever `ilike` matched and ordered it by
 * `sort_order`, so "shift knob" returned the catalog's first five products in
 * catalog order and called it a search.
 *
 * Everything here is pure: no React, no Supabase client, no `fetch`. That is
 * what lets the API route, the suggestion panel and the tests all agree on what
 * a query means, and it is what makes the ranking rules testable without a
 * database.
 *
 * ## Tiers, not a weighted sum
 *
 * The brief this was built to asks for two things that a single additive score
 * cannot both satisfy: fields must be weighted *relative to each other*, and an
 * exact match must beat a fuzzy one — always, not usually.
 *
 * A weighted sum gives you the first and quietly loses the second. A product
 * whose description happens to contain the query four times accumulates more
 * points than a product whose *name* is the query, and no choice of weights
 * fixes it in general, because the sum is unbounded in the number of weak
 * matches while the strong match is a single constant.
 *
 * So relevance is a **tier** plus a bounded refinement:
 *
 *     score = TIER_BASE[tier] + refinement,  refinement ∈ [0, 999]
 *
 * The tier bases are 1000 apart, so nothing that happens inside the refinement
 * band can promote a result past a result in a higher tier. Exact beats prefix
 * beats token beats tag beats body beats fuzzy, structurally. The refinement is
 * where the weighting, the recency nudge and the click feedback live, and it is
 * where they are all confined.
 *
 * ## What the tiers mean
 *
 * Highest to lowest, matching the order the brief asked for:
 *
 *   - `exact`      the name *is* the query
 *   - `prefix`     the name starts with the query
 *   - `tagExact`   a canonical tag or category name is the query — this is what
 *                  makes "shift knob" prefer a product filed under Shift Knobs
 *                  over one that merely mentions shift knobs in its description
 *   - `allTokens`  every word of the query appears in the name
 *   - `someTokens` some words of the query appear in the name
 *   - `tagToken`   words of the query appear in tags, category or slug
 *   - `body`       words of the query appear only in the description
 *   - `fuzzy`      nothing matched literally; the trigram/edit blend did
 *
 * ## Fuzzy matching, and why it is two measures
 *
 * `trigramSimilarity` reproduces PostgreSQL `pg_trgm.similarity()` exactly —
 * same word padding, same set-intersection-over-union — so that when the
 * candidate recall moves into Postgres behind a GIN trigram index (see the
 * migration proposed in `docs/search-architecture.md`), the database and this
 * module will agree about which rows are near misses and the ranking will not
 * shift under the change.
 *
 * Trigrams are poor at transpositions, which is the single most common typing
 * error: `walunt` against `walnut` scores 0.27, under Postgres' own 0.3
 * default. So a Damerau-style normalized edit distance runs alongside it and a
 * token is a near miss if *either* measure says so. That covers the three cases
 * the brief names — `braket`→`bracket` (trigram 0.50), `machning`→`machining`
 * (trigram 0.58), `walunt`→`walnut` (edit 0.83) — without lowering the trigram
 * threshold to a value that would start matching unrelated short words.
 *
 * Fuzzy matching is gated on `MIN_FUZZY_TOKEN_LENGTH`. Below four characters a
 * near miss is not a typo, it is a different word: at three characters `cnc`
 * and `cad` are one edit apart and both are real terms this shop uses.
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * The form every comparison happens in.
 *
 * Lowercased, accent-folded, and with hyphens and underscores treated as
 * spaces so `shift-knob` and `shift knob` are the same query — the same
 * transformation `normalizeSuggestQuery` already applies to what the customer
 * types, restated here because this module also normalizes *fields*, which
 * never pass through that function.
 */
export function normalizeForSearch(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    // The combining-diacritic block, so "Ébauche" and "ebauche" are one word.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(value: string | null | undefined): string[] {
  const normalized = normalizeForSearch(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

/**
 * A plural fold, used **only** when asking whether two strings are the same thing.
 *
 * Not a stemmer, and deliberately not one — stemming a whole index needs a
 * dictionary to be better than nothing, and a half-built one silently returns
 * the wrong product. This is the one morphological rule that pays for itself
 * here, because it is the mismatch a shop hits constantly: a customer types the
 * thing they want and the catalog files it under the plural. `shift knob` is
 * the category `Shift Knobs`; `cutting board` is `Cutting Boards`.
 *
 * Without it, the query that the brief itself uses as the worked example lands
 * one tier below where it belongs — a token hit rather than a category hit —
 * and a product whose description merely repeats the words can come closer than
 * it should.
 *
 * Applied to equality comparisons alone. Substring and fuzzy matching are left
 * untouched, so this can never make two genuinely different words equal: it
 * only ever removes a trailing `s`/`es` that both sides would have agreed on.
 */
export function foldPlural(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
      if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
      return word;
    })
    .join(" ");
}

/** Are these the same phrase, allowing for the singular/plural split? */
function sameThing(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || foldPlural(a) === foldPlural(b);
}

// ---------------------------------------------------------------------------
// Fuzzy measures
// ---------------------------------------------------------------------------

/**
 * The trigram set of a string, exactly as `pg_trgm` builds it.
 *
 * Postgres splits on non-alphanumerics, pads each word with two leading spaces
 * and one trailing space, and takes every 3-character window. `show_trgm('word')`
 * returns `{"  w"," wo",ord,"rd ",wor}` and so does this.
 */
export function trigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalizeForSearch(value).split(" ")) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** `similarity(a, b)` — shared trigrams over the size of the union. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Optimal string alignment distance — Levenshtein plus adjacent transposition.
 *
 * The transposition case is the reason this exists beside the trigram measure:
 * `walunt` is one transposition from `walnut` and six trigram-similarity points
 * short of Postgres' threshold.
 */
export function editDistance(a: string, b: string): number {
  const s = a;
  const t = b;
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  // Three rolling rows: the transposition case needs the row before last.
  let twoBack = new Array<number>(t.length + 1).fill(0);
  let oneBack = Array.from({ length: t.length + 1 }, (_, index) => index);
  let current = new Array<number>(t.length + 1).fill(0);

  for (let i = 1; i <= s.length; i++) {
    current[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(oneBack[j] + 1, current[j - 1] + 1, oneBack[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, twoBack[j - 2] + 1);
      }
      current[j] = best;
    }
    [twoBack, oneBack, current] = [oneBack, current, twoBack];
  }

  return oneBack[t.length];
}

/** Edit distance as a 0–1 similarity against the longer of the two strings. */
export function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** Postgres' own `pg_trgm.similarity_threshold` default. */
export const TRIGRAM_THRESHOLD = 0.3;
/** Where the edit measure takes over — one typo in a six-letter word. */
export const EDIT_THRESHOLD = 0.7;
/** Below this a near miss is a different word, not a typo. */
export const MIN_FUZZY_TOKEN_LENGTH = 4;

export type FuzzyVerdict = { matched: boolean; score: number };

/**
 * Is `candidate` a plausible typo of `token`?
 *
 * Returns the better of the two measures so the refinement band can prefer a
 * close near miss to a distant one, and `matched: false` for anything short
 * enough that the question is meaningless.
 */
export function fuzzyMatch(token: string, candidate: string): FuzzyVerdict {
  if (token.length < MIN_FUZZY_TOKEN_LENGTH || candidate.length < MIN_FUZZY_TOKEN_LENGTH) {
    return { matched: false, score: 0 };
  }
  const trigram = trigramSimilarity(token, candidate);
  const edit = editSimilarity(token, candidate);
  const matched = trigram >= TRIGRAM_THRESHOLD || edit >= EDIT_THRESHOLD;
  return { matched, score: Math.max(trigram, edit) };
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

export type RelevanceTier =
  | "exact"
  | "prefix"
  | "tagExact"
  | "allTokens"
  | "someTokens"
  | "tagToken"
  | "body"
  | "fuzzy"
  | "none";

/**
 * The tier bases, 1000 apart.
 *
 * The gap is the whole mechanism: the refinement added to a score is capped at
 * `MAX_REFINEMENT`, which is 999, so a result can never be lifted out of its
 * tier by field weighting, by recency, or by how many people have clicked it.
 */
export const TIER_BASE: Readonly<Record<RelevanceTier, number>> = {
  exact: 9000,
  prefix: 8000,
  tagExact: 7000,
  allTokens: 6000,
  someTokens: 5000,
  tagToken: 4000,
  body: 3000,
  fuzzy: 2000,
  none: 0,
};

export const MAX_REFINEMENT = 999;

/**
 * The refinement budget, split.
 *
 * Field weighting gets most of it, recency a nudge, and click-through the
 * smallest share of the three — see `CLICK_BOOST_MAX` for why it is last.
 */
export const FIELD_WEIGHT_MAX = 700;
export const RECENCY_MAX = 99;
/**
 * The hard ceiling on what behaviour can contribute.
 *
 * 200 points out of a 999-point band inside a single tier. A result that
 * everybody clicks cannot overtake a result in a better tier, cannot overtake a
 * much stronger textual match inside its own tier, and cannot compound: the
 * boost is a bounded function of a ratio, not of a count, so the thousandth
 * click is worth exactly as much as the twentieth — nothing.
 *
 * This is the safeguard against the runaway popularity loop, and it is
 * structural rather than a tuning choice. The previous implementation on
 * `/projects` computed `total * 4 + top3 * 3 + top1 * 3` with no ceiling at
 * all, so eight clicks on one write-up added 32 points to a scoring scheme
 * whose entire textual range was about the same size — after a few weeks the
 * most-clicked result was simply the first result for every query, which is the
 * loop the brief asks not to build.
 */
export const CLICK_BOOST_MAX = 200;
/** Below this many impressions a click-through rate is noise, not a signal. */
export const CLICK_MIN_IMPRESSIONS = 8;

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * One searchable thing, reduced to the fields that decide its rank.
 *
 * Deliberately not a product or a project — the ranker does not know what it is
 * ordering, which is what stops product-specific rules leaking into how a
 * project is scored and vice versa. The caller maps its rows onto this.
 */
export type SearchCandidate = {
  id: string;
  /** The name or title. The field every top tier is decided on. */
  title: string;
  /** Canonical, curated terms: category names, taxonomy tags, aliases. */
  tags?: readonly string[];
  /** The URL slug. A weak but exact signal. */
  slug?: string | null;
  /** Description, summary or body. The weakest textual field. */
  body?: string | null;
  /** ISO timestamp, for the tie-breaking recency nudge. */
  updatedAt?: string | null;
};

export type ScoredCandidate<T extends SearchCandidate = SearchCandidate> = {
  candidate: T;
  score: number;
  tier: RelevanceTier;
  /** Which measure put it in its tier. Surfaced for tests and debugging. */
  matchedOn: string;
  /** How much of the click budget it received. Always ≤ `CLICK_BOOST_MAX`. */
  clickBoost: number;
};

/** Aggregated behaviour for one result, as the analytics roll-up provides it. */
export type ClickStat = {
  impressions: number;
  clicks: number;
  /** Mean 0-based rank at which it was clicked, for position normalization. */
  averagePosition?: number | null;
};

/**
 * The click contribution, normalized for position and capped.
 *
 * Three defences against the feedback loop, in order:
 *
 * 1. **A minimum sample.** Under `CLICK_MIN_IMPRESSIONS` the rate is not
 *    computed at all, so one click on a new result buys nothing.
 * 2. **A ratio, not a count.** Click-through rate, so a result that is shown
 *    constantly and clicked occasionally does not out-earn a result that is
 *    shown rarely and clicked every time.
 * 3. **Position normalization.** A click on the first result is mostly evidence
 *    that it was first. Clicks at rank 0 are discounted hardest, and the
 *    discount fades with depth, so the signal is "people chose this over what
 *    was above it" rather than "this was already winning".
 */
export function clickBoost(stat: ClickStat | undefined | null): number {
  if (!stat) return 0;
  const impressions = Math.max(0, Math.floor(stat.impressions));
  const clicks = Math.max(0, Math.floor(stat.clicks));
  if (impressions < CLICK_MIN_IMPRESSIONS || clicks <= 0) return 0;

  const rate = Math.min(1, clicks / impressions);
  const position = Math.max(0, stat.averagePosition ?? 0);
  // 0.5 at the top of the list, rising towards 1 further down.
  const positionWeight = 0.5 + 0.5 * (position / (position + 2));

  return Math.min(CLICK_BOOST_MAX, Math.round(rate * positionWeight * CLICK_BOOST_MAX));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function containsToken(haystack: string, token: string): boolean {
  if (!haystack || !token) return false;
  return haystack.includes(token);
}

function bestFuzzyOverWords(field: string, token: string): number {
  let best = 0;
  for (const word of field.split(" ")) {
    if (!word) continue;
    const verdict = fuzzyMatch(token, word);
    if (verdict.matched && verdict.score > best) best = verdict.score;
  }
  return best;
}

function recencyPoints(updatedAt: string | null | undefined): number {
  if (!updatedAt) return 0;
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) return 0;
  const days = (Date.now() - time) / 86_400_000;
  if (days <= 0) return RECENCY_MAX;
  // Halves roughly every 90 days, so it only ever separates near-equal results.
  return Math.round(RECENCY_MAX / (1 + days / 90));
}

/**
 * Score one candidate against one query.
 *
 * Returns `tier: "none"` for a candidate that does not match at all, which the
 * caller filters out — scoring it is cheaper than deciding twice whether it
 * matched.
 */
export function scoreCandidate<T extends SearchCandidate>(
  candidate: T,
  rawQuery: string,
  stat?: ClickStat | null
): ScoredCandidate<T> {
  const query = normalizeForSearch(rawQuery);
  const tokens = query ? query.split(" ") : [];
  const title = normalizeForSearch(candidate.title);
  const slug = normalizeForSearch(candidate.slug ?? "");
  const body = normalizeForSearch(candidate.body ?? "");
  const tags = (candidate.tags ?? []).map((tag) => normalizeForSearch(tag)).filter(Boolean);

  const boost = clickBoost(stat);
  const recency = recencyPoints(candidate.updatedAt);

  const settle = (tier: RelevanceTier, matchedOn: string, fieldPoints: number): ScoredCandidate<T> => {
    const refinement = Math.min(
      MAX_REFINEMENT,
      Math.min(FIELD_WEIGHT_MAX, Math.max(0, Math.round(fieldPoints))) + recency + boost
    );
    return { candidate, score: TIER_BASE[tier] + refinement, tier, matchedOn, clickBoost: boost };
  };

  if (!query) return settle("none", "empty-query", 0);

  // --- exact and prefix, on the name ------------------------------------
  if (sameThing(title, query)) return settle("exact", "title", FIELD_WEIGHT_MAX);
  if (sameThing(slug, query)) return settle("exact", "slug", FIELD_WEIGHT_MAX - 40);
  if (title.startsWith(query)) {
    // A prefix that covers most of the name is a better prefix.
    return settle("prefix", "title", Math.round((query.length / Math.max(title.length, 1)) * FIELD_WEIGHT_MAX));
  }

  // --- a canonical tag or category IS the query -------------------------
  // The rule the brief names explicitly: "shift knob" must favour the product
  // filed under Shift Knobs over one whose description mentions the words. The
  // plural fold is what makes the singular the customer typed reach the plural
  // the catalog files under.
  if (tags.some((tag) => sameThing(tag, query))) return settle("tagExact", "tag", FIELD_WEIGHT_MAX);

  // --- token coverage of the name ---------------------------------------
  const titleHits = tokens.filter((token) => containsToken(title, token)).length;
  if (titleHits === tokens.length && titleHits > 0) {
    // Whole-word hits are worth more than hits buried inside a longer word.
    const wholeWords = tokens.filter((token) => title.split(" ").includes(token)).length;
    return settle("allTokens", "title", 400 + Math.round((wholeWords / tokens.length) * 300));
  }
  if (titleHits > 0) {
    return settle("someTokens", "title", Math.round((titleHits / tokens.length) * FIELD_WEIGHT_MAX));
  }

  // --- tags, category, slug ---------------------------------------------
  const tagText = tags.join(" ");
  const tagHits = tokens.filter((token) => containsToken(tagText, token)).length;
  const slugHits = tokens.filter((token) => containsToken(slug, token)).length;
  if (tagHits > 0 || slugHits > 0) {
    const coverage = Math.max(tagHits, slugHits) / tokens.length;
    // A tag hit outranks a slug hit: a tag is curated, a slug is derived.
    return settle("tagToken", tagHits >= slugHits ? "tag" : "slug", Math.round(coverage * (tagHits >= slugHits ? 600 : 420)));
  }

  // --- the body ----------------------------------------------------------
  const bodyHits = tokens.filter((token) => containsToken(body, token)).length;
  if (bodyHits > 0) {
    return settle("body", "body", Math.round((bodyHits / tokens.length) * 500));
  }

  // --- nothing literal matched: is it a typo? ---------------------------
  let fuzzyBest = 0;
  let fuzzyField = "";
  for (const token of tokens) {
    for (const [field, text, weight] of [
      ["title", title, 1],
      ["tag", tagText, 0.9],
      ["slug", slug, 0.7],
      ["body", body, 0.5],
    ] as const) {
      const similarity = bestFuzzyOverWords(text, token) * weight;
      if (similarity > fuzzyBest) {
        fuzzyBest = similarity;
        fuzzyField = field;
      }
    }
  }
  if (fuzzyBest > 0) {
    return settle("fuzzy", fuzzyField, Math.round(fuzzyBest * FIELD_WEIGHT_MAX));
  }

  return settle("none", "no-match", 0);
}

/**
 * Rank a candidate set, dropping everything that did not match.
 *
 * Stable within a score: ties fall back to the order the caller supplied, which
 * for the catalog is `sort_order` — the merchandising order the shop chose.
 */
export function rankCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  stats?: ReadonlyMap<string, ClickStat> | null
): ScoredCandidate<T>[] {
  const withOrder = candidates.map((candidate, index) => ({
    scored: scoreCandidate(candidate, query, stats?.get(candidate.id)),
    index,
  }));

  return withOrder
    .filter((entry) => entry.scored.tier !== "none")
    .sort((left, right) => right.scored.score - left.scored.score || left.index - right.index)
    .map((entry) => entry.scored);
}
