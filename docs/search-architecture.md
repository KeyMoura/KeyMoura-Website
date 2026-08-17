# Search architecture

What the site searches with today, what it searched with before, and the one
migration it now needs. Written during the final visual-consistency and
search-intelligence pass.

**Nothing in the "Proposed migration" section has been applied.** It is written
out so it can be reviewed and authorized, per the pass's migration rule.

---

## 1. What was already there

Two search systems existed, built at different times, and the audit found that
most of the older one's apparatus was connected to nothing.

### 1.1 The `/projects` system

| Piece | State | Evidence |
| --- | --- | --- |
| `search_info_pages(q, limit)` RPC | **Never returns rows** | Filters `status = 'published'`. The rest of the application — the suggest route, the `/projects` fallback, the review flow — writes and reads `status = 'approved'`. `info_pages_status_check` permits both, so the RPC is syntactically fine and semantically dead. |
| `info_pages_search_idx` (GIN, `gin_trgm_ops`) | **Never used** | The index is on `(coalesce(title,'') \|\| ' ' \|\| coalesce(content_markdown,''))`. The RPC matches `title ilike … OR content_markdown ilike …`, which is a different expression, so the planner cannot use it. `EXPLAIN` on the RPC's body shows `Index Scan using info_pages_status_idx` with the `ilike` terms as a `Filter`. |
| `info_pages_tags_idx` (GIN on `tags`) | Unused by search | The RPC's tag test is `exists (select 1 from unnest(p.tags) t where t ilike …)`, which unnests rather than probing the index. |
| `info_search_events` writes | **Rejected for every customer** | Written from the browser with the anon key. The table has RLS on and one permissive policy, `staff manage` (`is_staff_user()`). Production holds **7 rows**, all from staff sessions. |
| `info_search_click_events` writes | **Rejected for every customer** | Same cause. Production holds **0 rows**, ever. |
| Click-boost read | **Returns nothing for customers** | `select` on the click table is staff-only too, so `clickBoosts` was `{}` for everyone who was not staff. |
| Click-boost formula | **A runaway loop** | `total * 4 + top3 * 3 + top1 * 3`, uncapped, against a textual range of roughly 30 points. Eight clicks outweighed any possible textual match, and ranking first earns more clicks. |
| Client-side weighted ranking | **Real and working** | `title 12 / slug 8 / tag 10 / content 4` for typed tokens, `title 6 / slug 5 / tag 15 / content 3` for chips, per-token caps, `+20` per matched token. This was the one genuinely good part. |
| "Did you mean" | Real, very loose | Levenshtein, accepted at similarity ≥ 0.2. |

### 1.2 The navbar system (added in the previous pass)

Scope selector, grouped results, bounded server-side lookup, abort-on-keystroke,
`revalidate = 60`. All good, and all retained.

What it did **not** have: any ranking at all. Candidates came back from `ilike`
ordered by `sort_order` and were cut to five, so "shift knob" returned the
catalog's first five products in merchandising order. No typo tolerance, no
analytics.

### 1.3 Products have no text index

`products` carries `products_catalog_state_idx`, `products_public_order_idx`,
`products_category_id_idx`, `products_purchase_mode_idx`, the slug and SKU
uniques — and **nothing for text**. `EXPLAIN ANALYZE` on the suggest route's
product query:

```
Limit
  ->  Sort  (Sort Key: sort_order)
        ->  Seq Scan on products
              Filter: (is_published AND (archived_at IS NULL)
                       AND ((name ~~* '%shift knob%') OR (short_description ~~* '%shift knob%')
                            OR (category ~~* '%shift knob%')))
```

Three published products today, so 0.15 ms. It is a sequential scan per
keystroke and it scales linearly with the catalog.

---

## 2. What this pass changed, without a migration

- **`src/lib/search/relevance.ts`** — one ranking engine, pure and tested, used
  by the suggest endpoint. Tiered scoring (`exact` → `prefix` → `tagExact` →
  `allTokens` → `someTokens` → `tagToken` → `body` → `fuzzy`) with tier bases
  1000 apart and a refinement band capped at 999, so field weighting, recency
  and click feedback can order results **within** a tier and can never move one
  across a tier boundary.
- **Typo tolerance** — `trigramSimilarity` reproduces `pg_trgm.similarity()`
  exactly (same padding, same intersection-over-union), so recall can move into
  Postgres later without the ranking shifting. A Damerau-style edit measure runs
  alongside it because trigrams are poor at transpositions: `walunt`/`walnut`
  scores 0.27 by trigram and 0.83 by edit distance. Gated at four characters.
- **Weighted tags** — a product's category is fed to the ranker as a *tag*, not
  as body text, and a singular/plural fold makes the query `shift knob` reach
  the category `Shift Knobs`. This is the brief's worked example, and it now
  resolves to the `tagExact` tier rather than a token hit.
- **Scope constrains candidates**, not output — the category filter is applied
  to the candidate query so out-of-scope products cannot consume the five
  suggestion slots.
- **Ranking happens before the cut to five**, which is the change that makes the
  best match actually appear.
- **Analytics moved server-side** — `/api/public/search-event` and
  `/api/public/search-click` write with the service role after validating the
  payload in `src/lib/search/analytics.ts`. This is what makes the events exist
  at all, and it puts validation somewhere the client cannot skip.
- **The runaway click loop is gone** — `clickBoost` requires a minimum sample,
  uses a ratio rather than a count, normalizes for position, and is capped at
  200 points inside one tier.

### Cost of doing it without schema changes

The typo pass has no index to ask, so when the precise `ilike` query comes back
thin the route reads a bounded page (`FUZZY_RECALL_LIMIT = 200`) of the scope
and ranks in the application. That is complete for today's catalog and stops
being complete past 200 in-scope rows. It is the reason for the migration below.

---

## 3. Proposed migration — **not applied, awaiting authorization**

### 3.1 Why the existing schema cannot support it

| Capability | Blocker |
| --- | --- |
| Indexed product text search | No text index on `products` exists, and `ilike '%…%'` needs a `gin_trgm_ops` index on each searched column. |
| Typo tolerance inside Postgres | `similarity()` cannot be expressed through PostgREST filters, so it needs an RPC. |
| Click analytics for products and categories | `info_search_click_events.clicked_page_id` is `references info_pages(id)`. A product id cannot be stored: the table is structurally project-only. There is also no `result_type` and no `scope` column. |
| True click-through rate | Impressions are recorded per *search*, not per *result*, so a per-result CTR denominator does not exist. `clickBoost` currently receives share-of-clicks instead. |
| `search_info_pages` returning anything | It filters `status = 'published'`; the application writes `'approved'`. |
| `search_info_pages` using its index | Its `WHERE` does not match the indexed expression. |

### 3.2 Security finding to fix in the same migration

`anon` and `authenticated` both hold **`TRUNCATE`** on `info_search_events` and
`info_search_click_events`. `TRUNCATE` is not subject to row-level security, so
anyone holding the publicly-shipped anon key can empty both analytics tables.
This is the same default-privilege inheritance recorded previously for
`user_staff_notes`. RLS blocks their `INSERT`/`SELECT`; it does not block this.

### 3.3 Proposed contents

```sql
-- pg_trgm is already installed (extensions schema, v1.6). Nothing to create.

-- 1. Product text search --------------------------------------------------
create index concurrently if not exists products_name_trgm_idx
  on public.products using gin (name extensions.gin_trgm_ops);
create index concurrently if not exists products_short_description_trgm_idx
  on public.products using gin (short_description extensions.gin_trgm_ops);
create index concurrently if not exists products_category_trgm_idx
  on public.products using gin (category extensions.gin_trgm_ops);

-- 2. Repair the project search RPC ---------------------------------------
--    'approved' is the status the application actually writes, and the WHERE
--    is rewritten onto the expression info_pages_search_idx is built on so the
--    planner can use it.
create or replace function public.search_info_pages(q text, limit_results integer default 25)
returns setof public.info_pages
language sql stable
set search_path to 'public', 'pg_temp'
as $$
  select p.*
  from public.info_pages p
  where p.status = 'approved'
    and (
      coalesce(trim(q), '') = ''
      or (coalesce(p.title,'') || ' ' || coalesce(p.content_markdown,'')) ilike '%' || q || '%'
      or p.tags && array[q]
    )
  order by p.updated_at desc
  limit greatest(1, least(coalesce(limit_results, 25), 100))
$$;

-- 3. Generalize click analytics beyond info_pages -------------------------
alter table public.info_search_click_events
  drop constraint if exists info_search_click_events_clicked_page_id_fkey;

alter table public.info_search_click_events
  add column if not exists result_type text
    check (result_type in ('product','category','project','page')),
  add column if not exists result_id uuid,
  add column if not exists scope text;

-- Existing rows are all project clicks by construction.
update public.info_search_click_events
   set result_type = coalesce(result_type, 'project'),
       result_id   = coalesce(result_id, clicked_page_id)
 where result_type is null;

alter table public.info_search_events
  add column if not exists scope text;

-- 4. Roll-up indexes ------------------------------------------------------
create index concurrently if not exists info_search_click_events_result_idx
  on public.info_search_click_events (result_type, result_id, created_at desc);
create index concurrently if not exists info_search_events_query_idx
  on public.info_search_events (query, created_at desc);

-- 5. Close the TRUNCATE hole ---------------------------------------------
revoke truncate on public.info_search_events        from anon, authenticated;
revoke truncate on public.info_search_click_events  from anon, authenticated;
-- The browser never writes these any more; the server routes use service_role.
revoke insert   on public.info_search_events        from anon, authenticated;
revoke insert   on public.info_search_click_events  from anon, authenticated;
```

### 3.4 Backward compatibility

- The three product indexes are additive; nothing reads differently until a
  query is written to use them.
- `search_info_pages` keeps its signature and return type. Today it returns zero
  rows in every case, so no caller can regress. `/projects` already handles an
  empty result by falling through to its client pool.
- Dropping the `clicked_page_id` foreign key keeps the column and its data;
  `result_id` is backfilled from it in the same statement.
- Revoking `insert` is safe **only after** this pass ships, because this pass is
  what moved those writes to the server. Sequencing matters: deploy first, then
  migrate.
- `create index concurrently` cannot run inside a transaction block; Supabase's
  migration runner wraps statements, so sections 1 and 4 may need to be applied
  separately or without `concurrently` (the tables are small enough today that
  a brief lock is not a concern — 3 products, 0 info pages, 7 events).

### 3.5 Expected improvement

| Query | Now | After |
| --- | --- | --- |
| Product suggest | `Seq Scan on products`, linear in catalog size | Bitmap index scan on the trigram indexes |
| Typo recall | Application-side over ≤ 200 rows | `similarity()` in Postgres, index-backed, unbounded |
| Project search RPC | Zero rows, index unused | Bitmap Index Scan on `info_pages_search_idx` — verified: rewriting the predicate onto the indexed expression already produces that plan today |
| Product/category clicks | Cannot be stored | Stored, and feeding `clickBoost` |

### 3.6 Backfill

None required. Section 3 backfills `result_type`/`result_id` for the existing
rows in the same statement, and there are zero click rows to convert.

---

## 4. Still open after this pass

- Per-result impressions, so `clickBoost` receives a true click-through rate
  rather than share-of-clicks. Needs a column or a separate impressions table.
- An `All`-scope results **page**. All's suggestions span products and projects;
  its Enter still goes to `/catalog`, as it did before.
- `info_pages` is empty in production, so every project-side search path is
  exercised only by tests.
