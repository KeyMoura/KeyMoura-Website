import Link from "next/link";

import HomeMedia from "@/components/home/HomeMedia";
import ProductCard, { type ProductCardProduct, priceLabel } from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import { normalizePurchaseMode } from "@/lib/commerce/purchaseModes";
import {
  assurances,
  capabilityIntro,
  capabilityPanels,
  custom,
  featured,
  finalCta,
  making,
  materials,
  process,
  productFocus,
  questions,
  recentWork,
  steps,
} from "@/lib/home/content";
import type { RecentWorkItem } from "@/lib/home/recentWork";

/**
 * The homepage's middle: everything between the hero and the footer.
 *
 * ## The one rule these sections share
 *
 * Each is a plain function of its props. No section fetches, no section reads a
 * store, and no section knows whether its data came from Supabase or from a
 * fixture — which is what lets `/dev/visual` render every one of them, at every
 * breakpoint, with no database, no session and no lockdown in the way. That
 * property is the reason the responsive work in this pass could be *looked at*
 * rather than reasoned about.
 *
 * ## Section rhythm
 *
 * Sections alternate between the page ground and a raised band, and two of them
 * (`HomeCustomProject`, `HomeMaking`) break full width. The alternation is what
 * keeps a long page from reading as one column of stacked cards — the failure
 * mode the previous homepage had, where nine sections all sat in the same
 * 72rem box with the same gap between them.
 *
 * Nothing here introduces a colour. Every surface is `--panel`, `--panel-strong`
 * or the page ground, every accent is `--brand-primary`, and every button is a
 * semantic role, so the Appearance editor still owns the whole page.
 */

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

function SectionHead({
  id,
  label,
  title,
  body,
  link,
}: {
  id: string;
  label: string;
  title: string;
  body?: string;
  link?: { href: string; label: string };
}) {
  return (
    <Reveal className="home-section-head">
      <div className="home-section-heading">
        <p className="home-eyebrow">{label}</p>
        <h2 id={id} className="home-section-title">
          {title}
        </h2>
        {body ? <p className="home-section-body">{body}</p> : null}
      </div>
      {link ? (
        <Link href={link.href} className="home-section-link">
          {link.label}
          <span aria-hidden="true"> →</span>
        </Link>
      ) : null}
    </Reveal>
  );
}

// ---------------------------------------------------------------------------
// What KeyMoura does
// ---------------------------------------------------------------------------

/**
 * The capability story, as two large alternating panels rather than a grid of
 * icons. Each panel is a door — catalog, custom — so the section explains the
 * business and routes at the same time.
 *
 * The media alternates sides at `md` and stacks below it, image first, because
 * a text block followed by its picture reads correctly on a phone and a picture
 * orphaned above the next section's heading does not.
 */
export function HomeCapabilities({ media }: { media: (ProductCardProduct | null)[] }) {
  return (
    <section className="home-band" aria-labelledby="home-what" id="home-what">
      <div className="home-shell">
        <SectionHead id="home-what" label={capabilityIntro.label} title={capabilityIntro.title} body={capabilityIntro.body} />

        <div className="home-panels">
          {capabilityPanels.map((panel, index) => (
            <Reveal key={panel.title} className="home-panel" delay={index * 90}>
              <HomeMedia
                product={media[index] ?? null}
                alt={media[index]?.name ?? ""}
                ratio="5 / 4"
                sizes="(min-width: 1024px) 34rem, (min-width: 768px) 46vw, 100vw"
                className="home-panel-media"
              />
              <div className="home-panel-copy">
                <p className="home-eyebrow">{panel.label}</p>
                <h3 className="home-panel-title">{panel.title}</h3>
                <p className="home-panel-body">{panel.body}</p>
                {panel.cta ? (
                  <Link href={panel.cta.href} className="home-inline-link">
                    {panel.cta.label}
                    <span aria-hidden="true"> →</span>
                  </Link>
                ) : null}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Featured products
// ---------------------------------------------------------------------------

/**
 * The shop row.
 *
 * The card is `ProductCard` — the same component the catalog grid and the
 * catalog's list view render — so a homepage product cannot show a different
 * price, a different availability rule, or a different link from the one the
 * catalog would show for the same row. Editorial presentation here means more
 * space and fewer items, not a second card implementation.
 *
 * `showAvailability` stays off: a stock chip is decision-support in a catalog
 * you are filtering and noise in a three-item row you are being introduced to.
 * The product page and the catalog both still show it.
 */
export function HomeFeaturedProducts({ products }: { products: ProductCardProduct[] }) {
  return (
    <section className="home-section" aria-labelledby="home-featured">
      <div className="home-shell">
        <SectionHead
          id="home-featured"
          label={featured.label}
          title={featured.title}
          body={featured.body}
          link={featured.link}
        />

        {products.length ? (
          <Reveal stagger className="home-product-row">
            {/*
              No `priority` on any of these. On the old homepage the product row
              was the second thing on the page and eagerly fetching its first
              image was right; here it sits below the hero, the capability
              panels and the focus section — roughly 14,000px down at desktop
              width. Marking it priority would issue a high-priority request for
              an image nobody has scrolled to yet, in competition with the hero
              image that is the actual LCP candidate.
            */}
            {products.map((product) => (
              <ProductCard key={product.id} product={product} showAvailability={false} />
            ))}
          </Reveal>
        ) : (
          <Reveal className="home-empty">
            <p>{featured.empty}</p>
            <Link href={custom.primary.href} className="ui-btn ui-btn-primary">
              {custom.primary.label}
            </Link>
          </Reveal>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Product focus
// ---------------------------------------------------------------------------

/**
 * One product, large.
 *
 * Every word of the detail comes off the product row — name, category, short
 * description, and the price formatted by the catalog's own `priceLabel`, so a
 * quoted product still says "Price after review" here and a directly purchasable
 * one still shows its real price rather than a "from". Nothing about the
 * product is written on this page, which is what keeps the front door from
 * describing a product differently than the product page does.
 *
 * Rendered only when there is a product to render; there is no version of this
 * section with invented content in it.
 */
export function HomeProductFocus({ product }: { product: ProductCardProduct | null }) {
  if (!product) return null;

  const mode = normalizePurchaseMode(product.purchase_mode);

  return (
    <section className="home-section home-focus-section" aria-labelledby="home-focus">
      <div className="home-shell">
        <div className="home-focus">
          <Reveal className="home-focus-stage">
            <HomeMedia
              product={product}
              alt={product.name}
              ratio="4 / 3"
              sizes="(min-width: 1024px) 38rem, 100vw"
              parallax
              className="home-focus-media"
            />
          </Reveal>

          <Reveal className="home-focus-copy" delay={120}>
            <p className="home-eyebrow">{productFocus.label}</p>
            <h2 id="home-focus" className="home-section-title">
              {product.name}
            </h2>
            <p className="home-focus-body">{product.short_description || productFocus.fallbackBody}</p>

            <dl className="home-focus-facts">
              <div>
                <dt>Category</dt>
                <dd>{product.category || "Custom work"}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>{priceLabel(mode, product.starting_price_cents)}</dd>
              </div>
            </dl>

            <Link href={`/catalog/${product.slug}`} className="ui-btn ui-btn-primary home-cta-lg">
              {productFocus.action}
            </Link>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Custom work
// ---------------------------------------------------------------------------

/** The custom-work story, full width and tinted, so it reads as a chapter break. */
export function HomeCustomProject() {
  return (
    <section className="home-custom" aria-labelledby="home-custom">
      <div className="home-custom-wash" aria-hidden="true" />
      <div className="home-shell home-custom-inner">
        <Reveal className="home-custom-copy">
          <p className="home-eyebrow">{custom.label}</p>
          <h2 id="home-custom" className="home-custom-title">
            {custom.title}
          </h2>
          <p className="home-custom-body">{custom.body}</p>
          <p className="home-custom-detail">{custom.detail}</p>
          <div className="home-action-row">
            <Link href={custom.primary.href} className="ui-btn ui-btn-primary home-cta-lg">
              {custom.primary.label}
            </Link>
            <Link href={custom.secondary.href} className="ui-btn ui-btn-secondary home-cta-lg">
              {custom.secondary.label}
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

/**
 * The four steps, as a sticky story on desktop.
 *
 * The intro column sticks while the steps scroll past it, so the question
 * ("how does this work?") stays on screen next to each part of the answer. That
 * is the only place on this page where sticky earns its keep, and it is off
 * below `lg`: on a phone a sticky column is a block of the viewport you cannot
 * scroll away from.
 *
 * The rail beside the steps fills as the list passes through — decoration, and
 * declared as such. It is drawn by a scroll-linked CSS animation with no
 * JavaScript behind it; where that is unsupported the rail is simply drawn
 * full, which is why nothing is allowed to *mean* anything by its length.
 */
export function HomeProcess() {
  return (
    <section className="home-band" aria-labelledby="home-process">
      <div className="home-shell home-process">
        <Reveal className="home-process-intro">
          <p className="home-eyebrow">{process.label}</p>
          <h2 id="home-process" className="home-section-title">
            {process.title}
          </h2>
          <p className="home-section-body">{process.body}</p>
          <Link href={process.cta.href} className="ui-btn ui-btn-primary home-cta-lg home-process-cta">
            {process.cta.label}
          </Link>
        </Reveal>

        <div className="home-process-track">
          <span className="home-process-rail" aria-hidden="true">
            <span className="home-process-rail-fill" />
          </span>
          <ol className="home-steps">
            {steps.map((item, index) => (
              <Reveal as="li" key={item.step} className="home-step" delay={index * 60}>
                <span className="home-step-number" aria-hidden="true">
                  {item.step}
                </span>
                <div className="home-step-copy">
                  <h3 className="home-step-title">{item.title}</h3>
                  <p className="home-step-body">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// In the shop
// ---------------------------------------------------------------------------

/**
 * Materials, full width.
 *
 * The list is `/capabilities`' list, including its last entry — "Something
 * else? Ask first." A materials band that implies the shop will cut anything is
 * exactly the overpromise this pass was told to avoid, and naming the limit is
 * more convincing than padding the list would be.
 */
export function HomeMaking() {
  return (
    <section className="home-making" aria-labelledby="home-making">
      <div className="home-shell">
        <SectionHead id="home-making" label={making.label} title={making.title} body={making.body} link={making.link} />

        <Reveal stagger className="home-materials">
          {materials.map((item) => (
            <article key={item.title} className="home-material">
              <h3 className="home-material-title">{item.title}</h3>
              <p className="home-material-body">{item.body}</p>
            </article>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recent work
// ---------------------------------------------------------------------------

/**
 * Build write-ups.
 *
 * Title, category, and when it last changed — and nothing else. `info_pages`
 * also carries an author, and the surrounding application carries comment
 * counts, karma and verification badges for the people who write these. None of
 * that reaches the front page: a forum index is what this homepage is being
 * moved away from, and the useful signal in a build write-up is that the build
 * happened, not who upvoted it.
 *
 * The section disappears entirely when there is nothing public to show, rather
 * than rendering an empty shelf.
 */
export function HomeRecentWork({ items }: { items: RecentWorkItem[] }) {
  if (!items.length) return null;

  return (
    <section className="home-section" aria-labelledby="home-work">
      <div className="home-shell">
        <SectionHead
          id="home-work"
          label={recentWork.label}
          title={recentWork.title}
          body={recentWork.body}
          link={recentWork.link}
        />

        <Reveal stagger className="home-work-grid">
          {items.map((item) => (
            <article key={item.id} className="home-work-card">
              <p className="home-work-category">{item.category || "Build log"}</p>
              <h3 className="home-work-title">
                <Link href={`/projects/${item.slug}`} className="home-work-link">
                  {item.title}
                </Link>
              </h3>
              {item.updated_at ? (
                <p className="home-work-date">
                  <time dateTime={item.updated_at}>
                    {new Date(item.updated_at).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </p>
              ) : null}
            </article>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Before you commit, and the close
// ---------------------------------------------------------------------------

/**
 * The trust band and the questions, side by side at the decision point.
 *
 * Both were on the old homepage — the assurances inside the hero, the questions
 * inside the closing call to action. Neither belonged there: the hero had to
 * carry four paragraphs before the visitor knew what the business was, and the
 * closing section had to share its space with an accordion.
 */
export function HomeAssurances() {
  return (
    <section className="home-band" aria-labelledby="home-assurances">
      <div className="home-shell home-assurance-layout">
        <div className="home-assurance-main">
          <Reveal>
            <p className="home-eyebrow">Before you commit to anything</p>
            <h2 id="home-assurances" className="home-section-title">
              How ordering here works.
            </h2>
          </Reveal>

          <Reveal stagger className="home-assurance-grid">
            {assurances.map((item) => (
              <article key={item.title} className="home-assurance">
                <h3 className="home-assurance-title">{item.title}</h3>
                <p className="home-assurance-body">{item.body}</p>
              </article>
            ))}
          </Reveal>
        </div>

        <Reveal className="home-questions" delay={120}>
          <h3 className="home-questions-title">Common questions</h3>
          <div className="home-questions-list">
            {questions.map((item) => (
              <details key={item.question} className="home-question">
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
          <p className="home-questions-more">
            More detail in the <Link href="/design-guide">design &amp; tolerance guide</Link>.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/** The close: large, quiet, and two doors again — the same two the hero opened with. */
export function HomeFinalCta() {
  return (
    <section className="home-close" aria-labelledby="home-close">
      <div className="home-close-wash" aria-hidden="true" />
      <Reveal className="home-shell home-close-inner">
        <p className="home-eyebrow">{finalCta.label}</p>
        <h2 id="home-close" className="home-close-title">
          {finalCta.title}
        </h2>
        <p className="home-close-body">{finalCta.body}</p>
        <div className="home-action-row home-close-actions">
          <Link href={finalCta.primary.href} className="ui-btn ui-btn-primary home-cta-lg">
            {finalCta.primary.label}
          </Link>
          <Link href={finalCta.secondary.href} className="ui-btn ui-btn-secondary home-cta-lg">
            {finalCta.secondary.label}
          </Link>
        </div>
        <p className="home-close-quiet">
          <Link href={finalCta.quiet.href}>{finalCta.quiet.label}</Link>
        </p>
      </Reveal>
    </section>
  );
}
