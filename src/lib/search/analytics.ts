/**
 * What gets recorded about a search, and what is refused.
 *
 * ## Why the validation is here and not in the route
 *
 * Everything below is pure, so the rules about what may be written can be
 * tested without a database and cannot drift between the search endpoint and
 * the click endpoint. The routes do IO; this decides what the IO is allowed to
 * contain.
 *
 * ## Why any of this moved to the server at all
 *
 * The previous analytics wrote from the browser. `/projects` and the command
 * palette both did `supabaseBrowser().from("info_search_events").insert(...)`
 * with the anon key — and both tables have RLS on with a single permissive
 * policy, `staff manage`, requiring `is_staff_user()`. So for every visitor who
 * was not staff the insert was rejected, the catch logged to the console, and
 * nothing was stored. Production bears it out: seven search events, all of them
 * from staff sessions, and **zero** click events ever recorded.
 *
 * That is also why the `/projects` click-boost read returned nothing for real
 * customers — `select` on the click table is staff-only too — so the relevance
 * learning it implemented has never once run for a customer.
 *
 * Writing through a server route with the service role fixes both halves, and
 * puts the validation somewhere the client cannot skip. Which is the whole
 * point: the client supplies the ranking inputs, so the client must not be
 * trusted with them.
 *
 * ## What is deliberately not stored
 *
 * No IP address, no user agent, no referrer, and no free-text beyond the query
 * itself. The query is what the feature is for; everything else would be a
 * second, quieter analytics product nobody asked for. The signed-in user id is
 * stored because the tables already carry it and it is what lets a person's own
 * searches be deleted with their account (`on delete set null`), but it is never
 * read back into ranking — the roll-up aggregates over everyone.
 */

import { normalizeForSearch } from "@/lib/search/relevance";

/** Where a search happened. A closed set, so an invented source cannot be stored. */
export const SEARCH_SOURCES = ["storefront-nav", "catalog", "projects", "command-palette"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/**
 * What kind of thing was clicked.
 *
 * Closed for the same reason as the source, and because the roll-up keys on it:
 * an open set would let a caller invent a type that nothing aggregates and the
 * event would be written but never read.
 */
export const SEARCH_RESULT_TYPES = ["product", "category", "project", "page"] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

/** The longest query worth storing. Matches what the search itself accepts. */
export const MAX_QUERY_LENGTH = 80;
/** A rank beyond this is not a result anybody scrolled to; it is a bad payload. */
export const MAX_POSITION = 200;
/** More than this is not a result count, it is a client asserting one. */
export const MAX_RESULT_COUNT = 10_000;
/** Tokens are stored for aggregation, not as a transcript. */
export const MAX_TOKENS = 12;

export type SearchEventInput = {
  source: unknown;
  query: unknown;
  scope: unknown;
  resultCount: unknown;
};

export type ValidSearchEvent = {
  source: SearchSource;
  rawQuery: string;
  normalizedQuery: string;
  tokens: string[];
  scope: string;
  resultCount: number;
};

export type ClickEventInput = {
  source: unknown;
  searchEventId: unknown;
  resultType: unknown;
  resultId: unknown;
  position: unknown;
  scope: unknown;
  query: unknown;
};

export type ValidClickEvent = {
  source: SearchSource;
  searchEventId: string | null;
  resultType: SearchResultType;
  resultId: string;
  position: number;
  scope: string;
  rawQuery: string;
  normalizedQuery: string;
  tokens: string[];
};

export type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * The scope, as a bounded label.
 *
 * Accepts the shapes `searchScopes.ts` produces — `all`, `products`,
 * `projects`, `category:<slug>` — and nothing else. An unrecognised scope is
 * *not* an error: the search itself falls back to All for a stale bookmark, and
 * the analytics must record the same thing the search actually did rather than
 * refusing an event the customer experienced as normal.
 */
export function normalizeScope(value: unknown): string {
  if (typeof value !== "string") return "all";
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all" || trimmed === "products" || trimmed === "projects") return trimmed;
  const slug = trimmed.startsWith("category:") ? trimmed.slice("category:".length) : "";
  return /^[a-z0-9-]{1,64}$/.test(slug) ? `category:${slug}` : "all";
}

function cleanQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

function boundedInteger(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  if (rounded < 0 || rounded > max) return null;
  return rounded;
}

export function validateSearchEvent(input: SearchEventInput): Validation<ValidSearchEvent> {
  if (!SEARCH_SOURCES.includes(input.source as SearchSource)) {
    return { ok: false, reason: "unknown source" };
  }
  const rawQuery = cleanQuery(input.query);
  // An empty query is not a search. Storing it would make the "what do people
  // look for" report mostly rows about people focusing the box.
  if (!rawQuery) return { ok: false, reason: "empty query" };

  const resultCount = boundedInteger(input.resultCount, MAX_RESULT_COUNT);
  if (resultCount === null) return { ok: false, reason: "invalid result count" };

  const normalizedQuery = normalizeForSearch(rawQuery);
  return {
    ok: true,
    value: {
      source: input.source as SearchSource,
      rawQuery,
      normalizedQuery,
      tokens: normalizedQuery ? normalizedQuery.split(" ").filter(Boolean).slice(0, MAX_TOKENS) : [],
      scope: normalizeScope(input.scope),
      resultCount,
    },
  };
}

/**
 * A click, validated against everything a caller could get wrong or lie about.
 *
 * The rank in particular: it is the input to position normalization in the
 * ranking boost, so a client that sends `position: 0` for everything is
 * claiming every result was chosen from the top. It is bounded, and the boost
 * that consumes it is capped and requires a minimum sample — so the worst a
 * dishonest client achieves is a bounded nudge inside one tier, never a
 * reordering across tiers. See `CLICK_BOOST_MAX` in `relevance.ts`.
 */
export function validateClickEvent(input: ClickEventInput): Validation<ValidClickEvent> {
  if (!SEARCH_SOURCES.includes(input.source as SearchSource)) {
    return { ok: false, reason: "unknown source" };
  }
  if (!SEARCH_RESULT_TYPES.includes(input.resultType as SearchResultType)) {
    return { ok: false, reason: "unknown result type" };
  }
  // The id names a row that must already exist. A caller cannot introduce a new
  // one here, and a non-uuid is refused rather than stored as text — this is
  // the field an attacker would use to attach behaviour to an arbitrary target.
  if (!isUuid(input.resultId)) return { ok: false, reason: "invalid result id" };
  if (input.searchEventId != null && !isUuid(input.searchEventId)) {
    return { ok: false, reason: "invalid search event id" };
  }

  const position = boundedInteger(input.position, MAX_POSITION);
  if (position === null) return { ok: false, reason: "invalid position" };

  const rawQuery = cleanQuery(input.query);
  if (!rawQuery) return { ok: false, reason: "empty query" };
  const normalizedQuery = normalizeForSearch(rawQuery);

  return {
    ok: true,
    value: {
      source: input.source as SearchSource,
      searchEventId: isUuid(input.searchEventId) ? input.searchEventId : null,
      resultType: input.resultType as SearchResultType,
      resultId: input.resultId,
      position,
      scope: normalizeScope(input.scope),
      rawQuery,
      normalizedQuery,
      tokens: normalizedQuery ? normalizedQuery.split(" ").filter(Boolean).slice(0, MAX_TOKENS) : [],
    },
  };
}

/**
 * Which result types the **current** schema can store a click for.
 *
 * `info_search_click_events.clicked_page_id` carries
 * `references info_pages(id) on delete set null`, so the table can only hold a
 * click on a project. A product id inserted there violates the constraint; a
 * product id inserted with the constraint dropped would be a foreign key
 * pointing at the wrong table.
 *
 * Generalizing it — a `result_type` column, a nullable target per type, an
 * index for the roll-up — is a migration, and this pass does not apply
 * migrations. The proposal is written out in `docs/search-architecture.md`.
 *
 * Stated here as a constant rather than as a condition buried in the route, so
 * that when the migration lands there is exactly one line to change and the
 * validation, the roll-up and the tests all follow it.
 */
export const STORABLE_CLICK_TYPES: readonly SearchResultType[] = ["project"];

export function canStoreClick(resultType: SearchResultType): boolean {
  return STORABLE_CLICK_TYPES.includes(resultType);
}
