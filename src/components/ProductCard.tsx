"use client";

import Link from "next/link";
import ProductImage from "@/components/ProductImage";
import WishlistButton from "@/components/commerce/WishlistButton";
import CatalogProductAction from "@/components/catalog/CatalogProductAction";
import type { CatalogProduct } from "@/lib/commerceTypes";
import { productImageCandidates, type ProductMediaRef } from "@/lib/productImages";
import {
  availabilityPresentation,
  catalogAction,
  catalogPriceLabel,
  customizationSignal,
  CUSTOMIZATION_LABELS,
} from "@/lib/commerce/catalogActions";

export type ProductCardProduct = Pick<
  CatalogProduct,
  "id" | "name" | "slug" | "short_description" | "image_url" | "category" | "starting_price_cents" | "is_custom"
> &
  Partial<Pick<CatalogProduct, "purchase_mode">> &
  Partial<
    Pick<
      CatalogProduct,
      "availability_status" | "lead_time_text" | "inventory_policy" | "inventory_quantity" | "continue_selling_when_out_of_stock"
    >
  > & {
    product_media?: ProductMediaRef[] | null;
    /** The category trail, parent first, when the catalog resolved one. */
    category_trail?: string[] | null;
    /** Authoritative public material text. Never inferred — see below. */
    material?: string | null;
    /** Set by `loadCatalogData`. See `catalogActions.ts` for what they mean. */
    requires_configuration?: boolean | null;
    has_options?: boolean | null;
  };

/**
 * The wording rules live in `@/lib/commerce/productLabels`, not here.
 *
 * This file is a client module, and a function exported from a client module is
 * a client reference — the server cannot call it, only render it. The homepage's
 * product-focus section is a server component that needs one product's price
 * string, and importing it from here failed the production build with
 * "Attempted to call priceLabel() from the server".
 *
 * Re-exported so every existing importer — the catalog, the tests — keeps
 * working against the same names.
 */
export { cardAction, priceLabel, productPrice } from "@/lib/commerce/productLabels";

type ProductCardProps = {
  product: ProductCardProduct;
  /** Availability and customization signals are noise on the homepage. */
  showAvailability?: boolean;
  showWishlist?: boolean;
  /** The quick-add button. Off wherever a card is decoration rather than a shop. */
  showAction?: boolean;
  priority?: boolean;
};

/**
 * One product result for the whole site: the homepage row, the catalog grid,
 * and the catalog's list view.
 *
 * ## What changed in this pass, and why
 *
 * The old card was a bordered box containing a small photograph and five
 * roughly equal-weight rows. Three specific things made it read as a database
 * record rather than merchandise:
 *
 * 1. **The badge row floated.** `margin-top: auto` was on the *footer*, so
 *    price and button were pinned to the card floor and the availability pills
 *    rode on whatever happened to be above them. Measured in the browser across
 *    one row of three cards: the pills began 390px, 314px and 344px from the
 *    top of cards that were all exactly 493px tall — a 76px spread caused by
 *    nothing but a two-line title and a one-line description. The gap between
 *    the pills and the purchase region varied 0px to 55px, so on one card they
 *    touched.
 *
 *    The anchor moved. `.product-card-status` now carries `margin-top: auto`
 *    inside the body, so **status, price and action are one block welded to the
 *    card floor** and the slack a short description creates opens up *above*
 *    the status row where nothing is comparing itself across columns. The fix
 *    is structural, not per-card, which is what Phase 34 asked for.
 *
 * 2. **Everything wore a pill.** Availability, lead time and Customizable were
 *    three identical chips, so a shipping estimate shouted as loudly as
 *    "Currently unavailable". Availability keeps a chip and gets a tone;
 *    lead time became text beside it, because "Usually 3 days" is a detail of
 *    the availability, not a competing fact; and the customization signal is a
 *    quiet outline. No badge soup.
 *
 * 3. **The call to action was a decorative span reading "Buy now"** — which
 *    both lied (it went to a product page, it did not buy) and could not be
 *    pressed, since `pointer-events: none` was load-bearing for the card's
 *    stretched link. It is now a real control from `CatalogProductAction`,
 *    lifted above the overlay, and it says the thing it actually does.
 *
 * ## The two-layer contract, unchanged and still load-bearing
 *
 * The product name carries the card's single stretched link. That gives a
 * strict rule, enforced in `globals.css`:
 *
 *   - Everything decorative stays *below* the anchor's `::after` overlay.
 *   - Only genuinely independent controls are lifted above it:
 *     `.product-card-aside` (wishlist) and `.product-card-cta` (the action).
 *
 * Anything added here that gains `filter`, `opacity`, `transform`, or
 * `will-change` establishes a stacking context and, if it sits after the anchor
 * in the DOM without one of those classes, punches a hole in the card's hit
 * target. That is not hypothetical: a hover `filter` on the old call-to-action
 * is what made the button a dead zone while every other part of the card
 * navigated.
 *
 * ## Three regions, so one DOM can be two layouts
 *
 * `media`, `body` and `footer` are siblings rather than the footer living
 * inside the body. Stacked in a column that is the card you already know;
 * placed in three columns by `[data-catalog-density="list"]` it is a horizontal
 * result row. The server cannot read `localStorage`, so a second component
 * chosen from the stored preference would paint cards and then jump to rows on
 * every visit. One DOM, two CSS layouts, decided before first paint.
 */
export default function ProductCard({
  product,
  showAvailability = true,
  showWishlist = true,
  showAction = true,
  priority = false,
}: ProductCardProps) {
  const href = `/catalog/${product.slug}`;
  const decision = catalogAction(product);
  const availability = showAvailability ? availabilityPresentation(product) : null;
  const customization = showAvailability ? customizationSignal(product) : null;

  /*
   * The alternate angle, revealed on hover from `sm` upwards.
   *
   * Only when the product genuinely has a second image — no placeholder, no
   * duplicate of the first — and it is `loading="lazy"` on a plain <img> so a
   * grid of twelve products does not double its image payload for an effect
   * nobody has asked to see yet. Touch devices never reach the hover state and
   * lose nothing: the primary image is complete on its own.
   */
  const images = productImageCandidates(product);
  const hoverImage = images.length > 1 ? images[1] : null;

  /*
   * "INTERIOR / SHIFT KNOBS" — the trail when the catalog resolved one, the
   * flat `category` text otherwise. Uncategorized products fall back to the
   * business's own word for what they are rather than a blank line.
   */
  const trail =
    product.category_trail && product.category_trail.length
      ? product.category_trail
      : product.category
        ? [product.category]
        : ["Custom work"];

  return (
    <article className="product-card" data-action={decision.kind}>
      <div className="product-card-media">
        <ProductImage product={product} alt={product.name} priority={priority} />

        {hoverImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={hoverImage}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="product-card-hover-image"
          />
        ) : null}

        {showWishlist ? (
          <div className="product-card-aside">
            <WishlistButton productId={product.id} productName={product.name} variant="icon" />
          </div>
        ) : null}
      </div>

      <div className="product-card-body">
        <p className="product-card-eyebrow">
          {trail.map((name, index) => (
            <span key={`${name}-${index}`}>
              {index > 0 ? <span className="product-card-eyebrow-sep" aria-hidden="true">/</span> : null}
              {name}
            </span>
          ))}
        </p>

        <h3 className="product-card-title">
          <Link href={href} className="product-card-link">
            {product.name}
          </Link>
        </h3>

        {/*
          Clamped to two lines in the grid and four in the list view, in CSS.
          Reading more about a product without opening it is the whole reason a
          shopper switches to the list, and it is the one piece of content whose
          useful length genuinely differs between the two layouts.
        */}
        {product.short_description ? (
          <p className="product-card-description">{product.short_description}</p>
        ) : null}

        {/*
          Material, only where it is a real column with a real value.

          `products.material` is authoritative and staff-entered. It is shown
          verbatim and never derived: parsing "made from Walnut, Poplar and
          African Mahogany" out of a description would put a guess on a spec
          line, and a spec line is exactly where a guess does the most damage.
          Hidden by CSS in the densest layouts, where there is no room for it.
        */}
        {product.material ? (
          <p className="product-card-spec">
            <span className="product-card-spec-key">Material</span>
            <span className="product-card-spec-value">{product.material}</span>
          </p>
        ) : null}

        {/*
          The status row: the card's stable anchor.

          `margin-top: auto` lives here, not on the footer, so this row and the
          purchase region below it always sit on the card floor at a fixed
          distance from each other regardless of how long the title and the
          description turned out to be.
        */}
        {availability || customization ? (
          <div className="product-card-status">
            {availability ? (
              <span className="product-status-availability" data-tone={availability.tone}>
                {availability.label}
              </span>
            ) : null}

            {availability?.detail ? (
              <span className="product-status-detail">{availability.detail}</span>
            ) : null}

            {customization ? (
              <span className="product-status-custom" data-signal={customization}>
                {CUSTOMIZATION_LABELS[customization]}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="product-card-footer">
        <p className="product-card-price">{catalogPriceLabel(product)}</p>

        {showAction ? (
          <CatalogProductAction product={{ ...product, id: product.id, slug: product.slug, name: product.name }} href={href} />
        ) : (
          /*
           * Decorative, and deliberately not a second link: the card's one
           * anchor already covers this box, so a real <a> here would give the
           * same destination two tab stops and two screen-reader
           * announcements. Used where a card is a picture of the shop rather
           * than the shop itself — the design guide's specimen row.
           *
           * The word is "View details" rather than the decision's own label,
           * because this box cannot be pressed. A dead button reading "Add to
           * cart" is the exact failure this pass set out to remove.
           */
          <span className="product-card-action" aria-hidden="true">
            View details
          </span>
        )}
      </div>
    </article>
  );
}
