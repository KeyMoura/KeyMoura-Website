import Link from "next/link";

import HomeMedia from "@/components/home/HomeMedia";
import Reveal from "@/components/Reveal";
import { assurances, hero } from "@/lib/home/content";
import type { ProductImageSource } from "@/lib/productImages";

/**
 * The hero.
 *
 * ## What it has to do in about three seconds
 *
 * Say that this shop makes real physical things; say that you can both buy them
 * and have them made; and put the two doors — shop, and custom — in front of
 * the visitor before any storytelling starts. The headline carries the first
 * two, the button pair carries the rest, and neither is below the fold at any
 * width this page supports.
 *
 * ## Two products in the frame, not one
 *
 * A single product photograph reads as a product page. Two, offset and at
 * different sizes, read as a shop with a range — which is the actual claim. The
 * second frame is dropped rather than duplicated when only one product exists,
 * because the same photograph twice reads as a bug.
 *
 * ## Motion
 *
 * Three entrances, 0/120/240ms apart, and a slow drift on the media. Nothing
 * animates per word, nothing rotates, nothing intercepts the scroll, and the
 * buttons are hittable from the first paint — `Reveal` only ever transitions
 * opacity and transform on content that is already in the DOM and already laid
 * out. Under `prefers-reduced-motion`, or with scripting off, every one of
 * those entrances is simply the finished state.
 *
 * The `-1` heading order note: `home-hero-title` is the page's only `h1`, and
 * the eyebrow above it is a `<p>`, not a heading, so the outline starts at the
 * headline rather than at a label.
 */

type HomeHeroProps = {
  /** Lead product for the large frame; null renders the drawn panel instead. */
  lead: ProductImageSource | null;
  /** Optional second product for the offset frame. */
  support: ProductImageSource | null;
  leadAlt: string;
  supportAlt: string;
};

export default function HomeHero({ lead, support, leadAlt, supportAlt }: HomeHeroProps) {
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <div className="home-hero-wash" aria-hidden="true" />
      <div className="home-hero-rules" aria-hidden="true" />

      <div className="home-hero-inner">
        <div className="home-hero-copy">
          <Reveal>
            <p className="home-eyebrow">{hero.eyebrow}</p>
            <h1 id="home-hero-title" className="home-hero-title">
              {hero.titleLead} <span className="home-hero-accent">{hero.titleAccent}</span>
            </h1>
          </Reveal>

          <Reveal delay={120}>
            <p className="home-hero-lede">{hero.lede}</p>
          </Reveal>

          <Reveal delay={240}>
            <div className="home-hero-actions">
              {/*
                One primary, one secondary, one quiet — the Appearance 3.0
                roles, not hero-specific colours. A third solid button here
                would leave the page with no visual answer to "where do I
                start", which is the one question the hero exists to answer.
              */}
              <Link href={hero.primary.href} className="ui-btn ui-btn-primary home-cta-lg">
                {hero.primary.label}
              </Link>
              <Link href={hero.secondary.href} className="ui-btn ui-btn-secondary home-cta-lg">
                {hero.secondary.label}
              </Link>
              <Link href={hero.tertiary.href} className="home-hero-quiet">
                {hero.tertiary.label}
              </Link>
            </div>
          </Reveal>
        </div>

        <Reveal className="home-hero-stage" delay={180}>
          {/*
            No `ratio` on the lead frame: its shape changes three times across
            the breakpoints and CSS owns it. See `.home-hero-frame-lead`.

            The `sizes` hints describe the layout as it actually is — the hero
            is one full-width column until 1024px, where it becomes two — and
            this is the page's only `priority` image, because it is the only
            one that can be the largest contentful paint.
          */}
          <HomeMedia
            product={lead}
            alt={leadAlt}
            sizes="(min-width: 1024px) 28rem, 100vw"
            priority
            parallax
            className="home-hero-frame-lead"
          />
          {support ? (
            <HomeMedia
              product={support}
              alt={supportAlt}
              ratio="1 / 1"
              // Rendered only from 1024px up, at a fixed fraction of the stage.
              sizes="14rem"
              className="home-hero-frame-support"
            />
          ) : null}
        </Reveal>
      </div>

      {/*
        The assurance rail: four short statements, each one a behaviour of this
        application rather than a claim about the business. It is a list because
        it is a list, and it sits inside the hero so the first screen carries a
        reason to trust the two buttons above it.
      */}
      <div className="home-hero-foot">
        <ul className="home-hero-rail">
          {assurances.map((item) => (
            <li key={item.title}>{item.title}</li>
          ))}
        </ul>
        <a className="home-scroll-cue" href="#home-what">
          <span>{hero.scrollCue}</span>
          <span className="home-scroll-cue-line" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
