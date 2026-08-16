# Storage, tracking, and Terms audit

Storefront Discovery 4.0. Everything below was verified against the running
application and the source, not inferred from the dependency list.

Method: a signed-out visit to `/catalog` in a real browser, reading
`localStorage`, `sessionStorage`, `document.cookie` and every script host the
page actually loaded, cross-checked against `grep` over the source for cookie
writes and storage keys.

---

## 1. What the storefront actually stores

### Strictly necessary

| Mechanism | Provider | Party | Purpose | Persistence |
|---|---|---|---|---|
| Supabase Auth session | Supabase | First party | Keeps a signed-in customer signed in | Supabase default; cleared on sign-out |
| `km_cart` | KeyMoura | First party | Guest cart ownership before an account exists | 30 days (`cartSession.ts`) |
| `km_wishlist` | KeyMoura | First party | Guest wishlist ownership | 90 days (`wishlistSession.ts`) |
| `km_guest_order` | KeyMoura | First party | Guest access to one order they placed | `GUEST_ACCESS_WINDOW_HOURS` |
| `sca_install_session` | KeyMoura | First party | Installer session; not reachable on a live shop | 30 minutes, httpOnly |

All are first-party, all are functionally required for the feature the customer
just used, and none of them profile anybody.

### Functional / preferences (browser only, never sent to a server)

| Key | Purpose | Bound |
|---|---|---|
| `km.catalog.density` | List / 2 / 3 / 4 view choice | one value |
| `km.catalog.recent` | Recently-viewed products | 6 entries, ids and display text only |
| `scra_lockdown_ok` | Pre-launch lockdown unlock | one value |
| `scra_force_logout_seen` | Suppresses a repeated forced sign-out | one value |
| `last_seen_touch_ms`, `ip_log_touch_ms` | Throttle a presence and a security ping | one value each |

`km.catalog.recent` is new in this pass. It is clearable from a **Clear** button
on the strip itself, and it deliberately never reaches the server — see the
header comment in `lib/commerce/recentlyViewed.ts`.

### Analytics

| Provider | Mechanism | Cookies? | Notes |
|---|---|---|---|
| Vercel Web Analytics | `va.vercel-scripts.com` script | **No** | No cookie and no storage key observed in a real session |
| Vercel Speed Insights | Same origin | **No** | Core Web Vitals only |

### Error monitoring

| Provider | Configuration |
|---|---|
| Sentry | `enabled` only in production, `sendDefaultPii: false`, `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`, every event through `scrubSentryEvent` |

No session replay, no PII by default, 5% client trace sampling.

### Advertising, marketing, remarketing

**None.** No Google Analytics, no Tag Manager, no Meta Pixel, no advertising or
remarketing tag of any kind. Verified by reading the script hosts a real page
load produced: `localhost:3000` and `va.vercel-scripts.com`, and nothing else.

### Third parties reached only on request

- **Stripe** — payment pages, reached when a customer checks out.
- **Google / Facebook OAuth** — only when the customer chooses that button.

---

## 2. Cookie consent decision

**No consent banner was added, and that is the finding, not an omission.**

Every mechanism above is either strictly necessary or a browser-local
preference the customer set by using the site. The only third-party analytics in
place is Vercel's, which sets no cookie and writes no storage. There is no
advertising, no cross-site tracking, and no profile being built.

A banner would therefore ask for permission to do nothing, train customers to
dismiss consent dialogs without reading them, and add a compliance surface the
shop would then have to keep honest. The prompt for this pass was explicit that
a pointless popup is worse than none, and the evidence supports that reading.

**What would change this.** Adding any of the following should be treated as the
trigger to build real consent gating — with the tracker genuinely disabled until
consent exists, a Reject that is as easy to reach as Accept, and reopenable
preferences:

- Google Analytics, Tag Manager, or any tag that sets an identifier cookie
- A Meta / Google / TikTok advertising or remarketing pixel
- Sentry session replay
- Any A/B testing or personalisation tool that stores a bucket identifier

*Not legal advice, and this is not a compliance opinion. It is an accurate
record of what the software does, for whoever forms that opinion.*

---

## 3. Privacy Policy gaps found and closed

Before: the policy named categories of provider ("hosting, authentication, …
monitoring, and analytics") without naming any, and said nothing at all about
cookies or local storage.

After: providers are named, and a Cookies and local storage section states what
is stored, in which of the two classes, and that there is no advertising
tracking and no sale or sharing of personal information for advertising.

**Still for legal review** (wording deliberately not invented here):

- Whether a jurisdiction-specific rights section (CCPA/CPRA, GDPR) is needed for
  the customers this shop actually sells to
- Concrete retention periods; the policy says "as reasonably needed"
- A named contact or process for access/deletion requests beyond the support
  address
- Whether the Facebook OAuth option needs its own disclosure

---

## 4. Terms of Service: where agreement is taken

### The four customer-facing commitment points

| Point | Route | Before | After |
|---|---|---|---|
| Browsing | any public page | browsewrap (footer links) | **unchanged, deliberately** — no gate on reading the shop |
| Account creation | `/auth/login` (OAuth, magic link, password) | nothing | **action-adjacent notice**, both documents linked |
| Buying listed goods | `/cart` → `POST /api/cart/checkout` | nothing | **action-adjacent notice** under the Check out button |
| Custom project inquiry | `/orders/new` → `POST /api/orders/custom` | nothing | **unchanged, deliberately** — an inquiry is not a contract |
| **Approving a quote** | `POST /api/orders/[id]/quote` | nothing | **clickwrap + server enforcement + versioned record** |

### Why quote approval is the contractual point

Tracing `request → quote → approval → payment → production`: the request is an
inquiry with no price and no commitment; the quote is KeyMoura's offer;
**approval is where the order leaves `customer_review` for `awaiting_payment`
and the shop begins treating the job as real.** That is where material gets
committed against a customer's own specification, and it is the only point in
the flow where stronger agreement UX is proportionate.

### What now happens there

1. The page renders an unticked checkbox (`CustomOrderAgreement`) naming the
   Terms and the cancellation policy for made-to-order items.
2. The button is disabled until it is ticked.
3. The request sends `{ agreedToTerms: true, termsVersion: TERMS_VERSION }`.
4. **The server refuses the approval with 422** when the agreement is absent, or
   when the version does not match the currently published one. A stale tab, a
   direct `fetch`, or an edited client cannot approve a quote.
5. An `order.terms_accepted` audit event is written **before** the order moves,
   with `recordAuditEventStrict` — so an approval whose acceptance could not be
   recorded fails instead of proceeding unevidenced.

The record carries: account, order, order number, quote revision, agreed price,
Terms version, acceptance context, timestamp, and the actor IP the audit table
already captures. It does **not** carry a device fingerprint.

### Versioning

`TERMS_VERSION` in `lib/legal/terms.ts` is the published "Last updated" date of
`/terms`. `tests/legal-terms.test.ts` asserts the constant and the rendered page
agree, so they cannot drift. Because the version is written into each acceptance
record, revising the Terms cannot rewrite what a past customer agreed to: their
row keeps naming the version that governed them.

---

## 5. Schema: none required

Phase 102 of this pass allowed one legitimate schema exception for durable
acceptance records. **It was not needed.**

Inspected first, as instructed:

- No `terms_versions`, `agreements`, `consents`, or `acceptances` table exists.
- `orders.quote_accepted_at` and `order_quotes.accepted_at` already record *when*
  a quote was approved, but carry no Terms version.
- **`audit_logs` already carries every field an acceptance record needs**:
  `actor_user_id`, `actor_kind` (`customer` is an existing kind), `actor_ip`,
  `event_type`, `entity_type`/`entity_id`, `related_order_id`, `occurred_at`,
  `summary`, and a `metadata` jsonb. The `order.` prefix is already retained by
  `lib/audit/retention.ts`, so `order.terms_accepted` is kept rather than
  silently dropped.

Reusing it is strictly better than a new table here: one place to read a
customer's history, no new RLS surface, no new grants, no migration to roll
back, and it inherits the retention rules already agreed.

**If a dedicated table is ever wanted** — for example if acceptance needs to be
queried at scale, or the audit log's retention policy diverges — the smallest
additive migration would be roughly:

```sql
create table public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  terms_version text not null,
  context text not null,
  accepted_at timestamptz not null default now()
);
create index on public.terms_acceptances (user_id, accepted_at desc);
create index on public.terms_acceptances (order_id);
-- RLS: owner may select their own rows; insert is service-role only, because a
-- client that can write its own acceptance record can forge one.
-- Grants: select to authenticated, nothing to anon, all to service_role.
-- Retention: never deleted while the related order exists; a deleted account
-- nulls the order link rather than destroying the commercial record.
```

**This was not written and must not be applied without explicit authorization.**

---

## 6. Custom order terms: for legal review

The Terms cover customer-provided designs, manufacturing variation, and
cancellation by reference to the refund policy. The following custom-work
concepts are either thin or absent, and are flagged rather than drafted —
**no legal wording was invented in this pass**:

- Cancellation *after production has begun* on a one-off item
- Returns on custom / non-stock goods specifically
- Revision rounds: how many are included, and what a further one costs
- Ownership of and licence to customer-supplied CAD files, and how long they are kept
- Fitment responsibility where the customer supplied the measurements
- Material and finish variation tolerances stated as a commitment
- Lead-time estimates as estimates rather than promised dates
- Prototype and one-off expectations versus production parts
- Title and risk transfer on pickup versus shipping
