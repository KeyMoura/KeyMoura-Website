# Homepage 3.0 — Brand Storytelling, Motion & Commerce

Started from `14d46a4` (Commerce Discovery & Order History 3.0). Branch `homepage-3.0`.

Scope was the public homepage and the components it alone uses. Catalog, account,
orders, staff, production, support, analytics and user management were not
touched except where a homepage test needed repointing at code that had moved.

---

## 1. What the old homepage was

Nine blocks in one 72rem column, separated by a fixed 4.5rem gap:

| Block | Content |
| --- | --- |
| Hero | Eyebrow, headline, lede, two buttons, a note, and a bordered panel of three "assurances" |
| Capabilities | Four bordered cards |
| Products | Three `ProductCard`s |
| Process | Sticky intro + four bordered step cards |
| Gallery | Three title-only cards from `info_pages` |
| CTA | A tinted panel beside a FAQ accordion |

### Findings

**Structure.** Everything above lived inside `.home-sections`, a flex column with
one gap value. Nothing could break full width, no section had its own ground, and
the page read as a stack of cards because that is literally what it was. Six of
the nine blocks were bordered boxes.

**The hero did not say what the business is.** "Parts made to your drawing,
quoted before you pay" describes the custom half only. A visitor could not tell
there was anything to buy until they scrolled past two sections — and the primary
button was *Start a custom project*, with shopping demoted to secondary. The hero
also carried three paragraphs of assurance copy in a panel beside the headline,
so the first screen was dense before it was clear.

**Data.** `loadFeaturedProducts` and `loadFeaturedProjects` both used
`supabaseAdmin()` — the service-role client, which has `BYPASSRLS`. On this page
the `.eq("is_published", true)` and `.eq("status", "approved")` filters were the
*only* thing between a draft product or an unapproved write-up and the front
door. `supabasePublicServer`'s own docstring already called the homepage out for
this. The project query also asked only for `approved`, while the table's read
policy treats `approved` *and* `published` as public, so promoting a write-up
silently removed it from the homepage.

**Community era.** The gallery row rendered `info_pages` rows as title +
category, with a "Gallery" eyebrow and a link to `/projects`. Not a forum index,
but not a shop's recent work either — no image, no indication of what was made.

**Motion.** `Reveal` (shared IntersectionObserver, gated on `[data-motion="on"]`,
failsafe, reduced-motion safe) was already good and is kept. There was nothing
else: no parallax, no scroll-linked anything, no full-bleed media.

**Media.** `public/` contains two brand marks, a rank icon, a PDF worker and a
font. There is no homepage photography and there never was.

**Reusable.** `Reveal`, `ProductCard`, `ProductImage`, the appearance token
system, the four process steps, the materials list, and the FAQ text. All kept.

---

## 2. Reference sites — what was taken, and what was not

**Vita Travel** contributed *pacing*: sections that change ground rather than
repeat a card, media that moves at a different rate from the page, one sticky
passage used as a story device, and reveals that arrive slightly before you read
them. None of its layout, type, colour, section order or timing was copied.

**Radium** contributed *credibility posture*: naming materials and limits plainly
instead of adjectives, giving one product a large dedicated section, and keeping
the shop reachable from everywhere. Its layouts, wording and navigation were not
copied.

### Originality safeguards

- Every colour resolves to an existing KeyMoura appearance token. No palette
  from either reference exists in this repo.
- The section order is KeyMoura's own: the page opens by stating that the shop
  sells *both* stocked and one-off work, which is a KeyMoura-specific problem
  neither reference has.
- Copy is written against `/capabilities`, `/about` and the request flow.
- The one piece of non-photographic texture — the drawn sheet and the plotted
  hero rules — is derived from technical drawings, which is a thing this business
  produces.
- No stock photography. See §5.

---

## 3. New information architecture

| # | Section | Ground | Purpose |
| --- | --- | --- | --- |
| 1 | Hero | page + wash | Both halves of the business, both doors, trust rail |
| 2 | What we do | raised band | Two alternating panels: off the shelf / made to order |
| 3 | Product focus | page | One product, large, entirely from its own row |
| 4 | Featured products | page | Three shared `ProductCard`s |
| 5 | Custom work | brand wash, full bleed | The custom story as a chapter break |
| 6 | How it works | raised band | Four steps, sticky story at ≥1024 |
| 7 | In the shop | strong panel, full bleed | Materials and the stated limit |
| 8 | Made recently | page | Public build write-ups |
| 9 | How ordering works | raised band | Four assurances + FAQ |
| 10 | Close | brand wash, full bleed | Both doors again |

Ground changes five times top to bottom. Sections 5, 7 and 10 break full width.

**Hero.** H1 is *"Stocked parts, and parts that don't exist yet."* — the second
half in brand colour. It is the page's only `h1`; the eyebrow above it is a `<p>`
so the outline starts at the headline. Primary **Shop products**, secondary
**Start a custom project**, quiet **See recent work** — one primary, not five
equal buttons. The three assurance paragraphs moved out of the hero into §9 and
were replaced by a one-line rail of four short statements.

**Product focus** takes every word from the product row — name, category, short
description, and the price through the catalog's own `priceLabel`, so a
quote-only product still reads "Price after review". Nothing about the product is
written on this page.

**Recent work** shows title, category and date. No author, no `created_by`, no
counts, no karma, no comments. The section removes itself when there is nothing
public to show.

---

## 4. Motion

| Effect | Mechanism | Cost |
| --- | --- | --- |
| Section and element entrances | Existing `Reveal`, one shared IntersectionObserver | one observer per page |
| Hero and focus media drift | CSS `animation-timeline: view()` | compositor only |
| How-it-works rail fill | CSS `animation-timeline: view()` | compositor only |
| Scroll cue nudge | CSS keyframes | compositor only |

**No dependency was added, and no scroll listener exists.** Scroll-linked
movement is CSS scroll-driven animation, behind `@supports (animation-timeline:
view())`. Where unsupported, the authored rest state *is* the correct state: the
parallax elements sit at their scale with no translation, and the rail is drawn
full. Nothing means anything by its motion, which is what makes it safe to
remove.

Motion hierarchy: the hero and the focus media move; section headings and cards
fade and lift; small controls do not animate at all.

### Reduced motion

Verified by removing `data-motion` from `<html>`, which is exactly the state a
reduced-motion visitor (or a visitor with no JavaScript, or a failed hydration)
gets:

- 25 / 25 reveals at full opacity, 14 / 14 stagger children at full opacity
- 0 residual transforms
- parallax `animation-name: none`, rail `none`, scroll cue `none`
- rail `transform: none` — drawn full, static

Every scroll-linked rule is nested inside **both**
`@media (prefers-reduced-motion: no-preference)` **and** `[data-motion="on"]`,
and a test walks the CSS to prove each one is.

---

## 5. Media

There is no KeyMoura homepage photography, and stock photography of somebody
else's workshop at full bleed above the fold would be a lie in the most prominent
place on the site. So `HomeMedia` has two paths:

1. **A product with media** renders through the same `ProductImage` the catalog
   uses — same candidate ordering, same fall-forward through broken URLs, same
   optimizer decision.
2. **No media** renders a drawn panel: a plotted grid, corner registration marks,
   and the brand mark. It is `aria-hidden`, and it occupies exactly the layout
   real media will take later. This is what a fresh install and a catalog outage
   look like, and both are presentable.

Frames always declare an aspect ratio, so the box is the same size before,
during and after loading.

`allocateMedia` in the route shares the few available photographs out by
prominence — focus first, then the row, then the hero and panels rotate over
what is left — so nothing repeats in adjacent sections until the catalog is
smaller than the page.

---

## 6. Responsive

Verified in the browser at every required width against the real components.

| Width | Overflow | hero/panel/row/focus/process/materials/work/assurance | Sticky | Hero frame | Targets < 24px |
| --- | --- | --- | --- | --- | --- |
| 375 | none | 1/1/1/1/1/1/1/1 | off | 4:5 | 0 |
| 430 | none | 1/1/1/1/1/1/1/1 | off | 4:5 | 0 |
| 640 | none | 1/1/2/1/1/2/2/1 | off | 3:2 | 0 |
| 768 | none | 1/2/2/1/1/2/2/1 | off | 3:2 | 0 |
| 900 | none | 1/2/2/1/1/2/2/1 | off | 3:2 | 0 |
| 1024 | none | 2/2/3/2/2/4/3/2 | on | 4:5 | 0 |
| 1280 | none | 2/2/3/2/2/4/3/2 | on | 4:5 | 0 |
| 1440 | none | 2/2/3/2/2/4/3/2 | on | 4:5 | 0 |

Both compositions — full and empty — were measured at each width.

### Three problems the walkthrough found

1. **The hero went two-column at 768** and gave the lead photograph a 235px
   column. Moved to 1024, where it gets 412px. Every split section now turns at
   the same width, so there is no band where one section is two columns and its
   neighbour is not.
2. **A 4:5 hero frame at 640 was 760px tall** — a wall of image between the
   buttons and everything under them. The frame's ratio is now owned by CSS and
   changes three times: portrait on phones, landscape while stacked, portrait
   again beside the copy.
3. **The hero buttons wrapped badly below 480px** — the primary alone on the
   first row, the secondary sharing the second with the quiet link, giving the
   most important control the smallest target. They now stack full width.

Also fixed: the FAQ rows had a 24px tap target inside a 52px-looking row (the
padding was on the `<details>`, not the `<summary>`); section links and the
scroll cue were 18–23px tall. All interactive elements that are not inline text
links are now ≥24px.

---

## 7. Accessibility

- One `h1`; heading levels never skip (asserted against rendered markup).
- Every `aria-labelledby` resolves to an id that exists on the page.
- All decorative layers — washes, plotted rules, the drawn sheet, the progress
  rail — are `aria-hidden`.
- 30 tab stops, no adjacent duplicate destinations, every link with a meaningful
  name. Product cards keep the Commerce 3.0 contract of one link plus the
  wishlist toggle.
- Contrast measured against composited backgrounds: lowest 7.53:1, most 8:1+,
  headings 20:1. AA everywhere with margin.
- Global `:focus-visible` covers every new control; no card clips its outline.
- Nothing conveys meaning through motion alone.

---

## 8. Performance

- **One eager image on the page**, and it is the hero — the only LCP candidate.
  The featured row previously carried `priority` on its first card, which was
  correct when the row was near the top and wrong now that it sits ~14,000px
  down; it would have raced the hero for bandwidth.
- `sizes` on every frame describes the layout as it actually is, including the
  moved 1024px hero breakpoint.
- **CLS**: every frame declares `aspect-ratio`, so no image resizes its box.
  Entrances animate `opacity` and `transform` only.
- No animation dependency, no scroll listener, no `requestAnimationFrame`.
- Two bounded queries (6 products, 3 write-ups), each one round trip plus one
  batched media query — not one per card.
- `/` still prerenders static with `revalidate = 300`.

---

## 9. Data and security

Both loaders now read as the **public** through `supabasePublicServer`, so RLS
runs behind every filter instead of the filter being the only guard:

- `loadFeaturedProducts(6)` lives in `catalogData.ts` beside `loadCatalogData`,
  sharing its column list, publication filter and `sort_order` → newest ordering
  — which is exactly what the catalog calls "Featured". A merchandiser who
  reorders the catalog reorders the homepage. It is a second *query*, not a
  second *source*; asking `loadCatalogData` for six cards would fetch every
  product and all their media.
- `loadRecentWork(3)` filters `status in ('approved','published')` — matching the
  table's own read policy, which fixes the old query silently dropping promoted
  pages. It selects id, title, slug, category and updated_at, and nothing that
  identifies a person.

Both resolve to an empty list on failure rather than throwing: a catalog outage
should cost a section, not the front page.

---

## 10. Appearance integration

No new appearance role, and no new control in the Appearance editor — the
homepage needed none.

- Zero hard-coded colours in the homepage CSS (asserted; the only hex values are
  neutral black shadow alphas).
- Surfaces are `--panel` / `--panel-strong` / `--border`; accent is
  `--brand-primary`; text is `--text` / `--muted` / `--heading`.
- Every CTA is a semantic role — `ui-btn-primary`, `ui-btn-secondary`,
  `ui-btn-ghost`. `.home-cta-lg` sets padding and font size only, never colour,
  so the Primary button *style* setting still reaches the hero.
- `[data-card-style]` and `[data-content-width]` still govern homepage surfaces.
- The old `!px-6 !py-3` Tailwind important-overrides on the hero buttons are gone.

---

## 11. Development harness

`/dev/visual` now renders the homepage twice, outside the harness container so
full-bleed sections measure correctly:

- `#home-full` — six fixture products, two carrying inline data-URI media so both
  the image path and the drawn-sheet path appear side by side.
- `#home-bare` — no products, no media, no write-ups.

The sections are plain functions of their props with no `"use client"`, no
fetching and no store access, which is what made this pass measurable at all: `/`
needs Supabase and this deployment's lockdown gate hides pages client-side, so
without the harness "does the hero hold together at 900px" could only be answered
by shipping. A test asserts the harness renders the same ten sections the route
does.

---

## 12. Validation

### The bug only the deployed build found

The first preview deployment failed to prerender `/`:

```
Attempted to call priceLabel() from the server but priceLabel is on the client.
```

`HomeProductFocus` is a server component and imported `priceLabel` from
`ProductCard`, which carries `"use client"`. A function exported from a client
module is a client *reference* — the server gets a marshalling stub, not the
function.

Everything local passed, and passed for the wrong reason: the local build ran
with placeholder Supabase credentials, so there were no products, so the focus
section returned `null` before it ever reached the call. Type-checking cannot see
this either — the types are identical on both sides of the boundary.

Fixed by moving `productPrice`, `priceLabel` and `cardAction` into
`src/lib/commerce/productLabels.ts`, a module with no directive, and re-exporting
them from `ProductCard` so every existing importer is unaffected. Nothing in them
was ever client-specific; living in a component file is what hid that.

A test now walks the imports of every homepage section and fails if one calls a
binding from a `"use client"` module. It was checked by reintroducing the bug:
the guard fails with the right message, and passes once reverted. (Its first
draft did *not* fire — the import regex only matched `import { named }` and the
real failure arrived through `import Default, { named }`.)

### Results

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `tests/homepage-3.test.ts` | 39 / 39 pass |
| Full suite, this branch | 2191 tests, 2185 pass, **6 fail** |
| Full suite, `main` (`14d46a4`) | 2152 tests, 2146 pass, **6 fail** |
| `npx eslint src`, this branch | 277 problems (128 errors, 149 warnings) |
| `npx eslint src`, `main` | 277 problems (128 errors, 149 warnings) — identical |
| `npx eslint` on every touched file | 0 problems |
| `git diff --check` | clean |
| `npm run build` | succeeds; `/` static, revalidate 5m |

The same 6 failures fail on `main` and are untouched by this pass: fulfillment
workflow, refund timelines, customer hub, service-role guards, staff menu
reachability, staff menu deletions.

Four existing tests asserted homepage copy and markup against `src/app/page.tsx`,
where they no longer live. They were **repointed, not deleted** — at
`src/lib/home/content.ts` and `src/components/home/` — and each kept its subject.

The build ran with documented placeholder environment variables; no production
service was called.

---

## 13. Migrations and production safety

**Zero migrations.** No SQL was written, modified or applied.
`20260811025000_public_profile_projection.sql` and
`20260811030000_security_boundary_hardening.sql` are untouched and unapplied; a
test asserts no migration newer than those two exists and that homepage source
contains no DDL.

Nothing was mutated in production: no product, project, customer, order, role or
auth change; no email sent; no Stripe call; no migration applied; no force push.
All homepage inspection was local and read-only, against a Supabase URL pointed
at a closed port.

---

## 14. Remaining gaps

1. **There is still no homepage photography.** Every frame currently falls back
   to the drawn sheet unless a product carries media. The structure is built for
   real images — a workshop shot, a process shot, a finished-part detail — to be
   dropped in without layout work, but until someone uploads them the page leans
   on product photography and a drawn panel.
2. **Recent work has no imagery** because `info_pages` has no cover-image column.
   Adding one is a schema change and was therefore out of scope. Until then the
   cards are title, category and date, which is honest but not the image-led
   treatment the brief describes.
3. **Scroll-driven animation is Chromium and Safari 26+.** Firefox users get the
   static composition. This is a deliberate progressive-enhancement trade rather
   than shipping a JavaScript scroll loop.
4. **A pre-existing hydration warning** on `<html data-motion>` remains — the
   pre-paint script sets the attribute React did not render. It is the mechanism
   that keeps content visible without scripting, it predates this pass, and
   suppressing it would suppress every `<html>` attribute warning, so it was left
   alone and is recorded here instead.
5. **No homepage search affordance was added.** The header already carries
   search, and duplicating the catalog toolbar on the homepage would be the
   clutter Phase 30 warns about.
6. **Scroll reveals and parallax could not be watched in motion.** The browser
   pane does not composite frames, so transitions freeze at their start value and
   screenshots are unavailable. Reveal state was verified by asserting
   `data-revealed` and then measuring computed opacity with transitions disabled;
   the scroll-driven animations were verified as declared (`animation-timeline`,
   range, keyframe name) rather than watched running.
