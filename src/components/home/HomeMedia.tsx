import ProductImage from "@/components/ProductImage";
import { productImageCandidates, type ProductImageSource } from "@/lib/productImages";

/**
 * The homepage's picture frame.
 *
 * ## There is no homepage photography, and this is what that means
 *
 * `public/` holds two brand marks, a rank icon, a PDF worker, and a font. Every
 * real photograph this business owns is a product photograph, uploaded by staff
 * and served from Supabase Storage. So the homepage has exactly two honest
 * sources of imagery: the products themselves, and nothing.
 *
 * Stock photography was the obvious third option and is the one thing a shop
 * page like this must not do — a workshop that is not this workshop, shown at
 * full bleed above the fold, is a lie told in the most prominent place on the
 * site.
 *
 * So the frame does two jobs:
 *
 * 1. When a product has media, it renders that media, through the same
 *    `ProductImage` the catalog uses. One image pipeline for the whole site:
 *    the same candidate ordering, the same fall-forward through broken URLs,
 *    the same optimizer decision.
 * 2. When it does not, it renders a drawn panel — a plotted grid, a corner
 *    registration mark, and the brand mark — rather than an empty box or a
 *    grey rectangle. It reads as a drawing sheet, which is a thing this
 *    business actually produces, and it holds the exact layout real media will
 *    occupy later.
 *
 * That second case is not a stopgap to be removed. It is what the section looks
 * like on a fresh install and after a catalog outage, and it has to be
 * presentable in both.
 *
 * ## Aspect ratio is always declared
 *
 * `ratio` sets a CSS custom property the frame's `aspect-ratio` reads, so the
 * box is the same size before, during and after loading. Nothing on this page
 * is allowed to reserve its space by accident: the hero frame is the largest
 * element above the fold, and a late-arriving image that resizes it would move
 * every call to action underneath.
 */

type HomeMediaProps = {
  product: ProductImageSource | null | undefined;
  alt: string;
  /**
   * CSS aspect-ratio value for the frame, e.g. "4 / 3".
   *
   * Omit it when the frame's shape depends on the breakpoint — an inline
   * custom property cannot hold a media query, and it would out-specify the
   * stylesheet rule trying to change it. The hero's lead frame is the case:
   * it is portrait, then landscape, then portrait again, and `globals.css`
   * owns all three.
   */
  ratio?: string;
  /** Responsive width hint handed to the image optimizer. */
  sizes?: string;
  priority?: boolean;
  /**
   * Adds the scroll-linked drift. Reserved for the two or three largest frames
   * on the page — a small image that moves is a distraction, not a flourish.
   */
  parallax?: boolean;
  className?: string;
};

export default function HomeMedia({
  product,
  alt,
  ratio,
  sizes = "(min-width: 1024px) 40rem, 100vw",
  priority = false,
  parallax = false,
  className,
}: HomeMediaProps) {
  const hasImage = productImageCandidates(product).length > 0;
  const classes = ["home-media", parallax ? "home-media-parallax" : null, className].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      style={ratio ? ({ ["--home-media-ratio" as string]: ratio } as React.CSSProperties) : undefined}
      data-has-image={hasImage}
    >
      {hasImage && product ? (
        <ProductImage product={product} alt={alt} sizes={sizes} priority={priority} className="home-media-image" />
      ) : (
        /*
         * Decorative in the strict sense: the panel carries no information the
         * surrounding copy does not already state, so announcing it would add a
         * stop to the reading order for a texture. The section's heading and
         * body are the accessible content here.
         */
        <div className="home-media-sheet" aria-hidden="true">
          <span className="home-media-mark">KM</span>
        </div>
      )}
    </div>
  );
}
