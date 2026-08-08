-- ============================================================================
-- The submission revision history the review page has always tried to write
-- ============================================================================
--
-- `/staff/info/pending/[id]` records a before-and-after for every review action
-- and offers an Undo that restores the previous title and body from that
-- record. It reads and writes four columns — `previous_title`, `new_title`,
-- `previous_content_markdown`, `new_content_markdown` — and
-- `info_page_review_events` has never had any of them.
--
-- Both halves failed, and the failure was silent in the way this pass keeps
-- finding: the insert was refused, so no event was ever stored, and the select
-- was refused, so the history list rendered empty rather than erroring. The
-- page therefore showed "no events" for a table that was never being written
-- to, and Undo had nothing to restore. It failed **closed** — at no point was
-- wrong content written to a page — which is why it went unnoticed.
--
-- Found by `tests/staff-schema-contract.test.ts`, which compares every literal
-- `.from(t).select(c)` in the application against a capture of
-- `information_schema.columns` taken from production. It was registered there
-- as known drift and is fixed here at the owner's direction.
--
-- Additive and default-safe:
--   * four nullable `text` columns, matching the types they mirror
--     (`info_pages.title` and `info_pages.content_markdown` are both `text`);
--   * no default and no NOT NULL, so the existing rows need no backfill — and
--     there are **zero** of them, precisely because every insert was refused;
--   * null is meaningful and permanent: an event recorded before this migration
--     genuinely has no before-and-after to show. The page must render that as
--     "not recorded" rather than as an empty diff, and never offer Undo for it;
--   * no grant is issued, and none is needed. Privileges here are table-level
--     (`authenticated` and `service_role` hold SELECT/INSERT/UPDATE/DELETE;
--     `anon` holds only the inert REFERENCES/TRIGGER/TRUNCATE) and a new column
--     inherits them;
--   * no policy change. The table carries no RLS policies and adding a column
--     does not alter `relrowsecurity`.
--
-- Deliberately **not** done here: backfilling anything, or reconstructing
-- history from `info_pages`. There is no record of what those revisions were —
-- inventing one would put fabricated content behind an Undo button.

alter table public.info_page_review_events
  add column if not exists previous_title text,
  add column if not exists new_title text,
  add column if not exists previous_content_markdown text,
  add column if not exists new_content_markdown text;

comment on column public.info_page_review_events.previous_title is
  'Page title before this review action. Null on events recorded before pass 14, which have no before-and-after.';
comment on column public.info_page_review_events.new_title is
  'Page title after this review action. Null on events recorded before pass 14.';
comment on column public.info_page_review_events.previous_content_markdown is
  'Page body before this review action, and the source Undo restores from. Null on events recorded before pass 14.';
comment on column public.info_page_review_events.new_content_markdown is
  'Page body after this review action. Null on events recorded before pass 14.';
