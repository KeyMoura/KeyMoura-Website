import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight } from "@fortawesome/free-solid-svg-icons";

/**
 * The custom-project offer, and where it is allowed to appear.
 *
 * ## Why this is a component and not a line of JSX in two places
 *
 * "We can make it instead" is KeyMoura's real differentiator and the single
 * most useful thing to say to somebody the catalog just failed. It is also the
 * easiest thing in the shop to overdo: it used to sit in the catalog page
 * header, above the products, on every category page — a sentence apologising
 * for the catalog before the customer had looked at it.
 *
 * So it has exactly two homes, and they are both *after* the browsing:
 *
 *   - `variant="empty"` — inside the no-results state, where it is the most
 *     likely next step and gets full weight.
 *   - `variant="footer"` — a quiet rule at the bottom of a page that *did*
 *     have results, for the customer who read all of them and none fit.
 *
 * Deliberately absent from: the page header, the top of category pages, and
 * anywhere beside a product that can actually be bought.
 */
export default function CatalogRecovery({
  variant,
  /** The search that found nothing, quoted back so the offer is about *their* thing. */
  term,
}: {
  variant: "empty" | "footer";
  term?: string | null;
}) {
  if (variant === "empty") {
    return (
      <div className="catalog-recovery is-empty">
        <p className="catalog-recovery-eyebrow">Can&apos;t find what you need?</p>
        <p className="catalog-recovery-title">
          {term ? <>We probably haven&apos;t listed it — but we can make it.</> : <>Start a custom project.</>}
        </p>
        <p className="catalog-recovery-body">
          Send a drawing, a CAD file, or a description of the part. We review it, quote it, and nothing is
          charged until you approve the scope and the price.
        </p>
        <Link href="/orders/new" className="ui-btn ui-btn-primary">
          Start a custom project
        </Link>
      </div>
    );
  }

  return (
    <aside className="catalog-recovery is-footer" aria-label="Custom work">
      <div>
        <p className="catalog-recovery-title">Most of what we make never reaches this page.</p>
        <p className="catalog-recovery-body">
          One-offs, replacements, and parts built to a drawing. Tell us what you need and we will quote it.
        </p>
      </div>
      <Link href="/orders/new" className="catalog-recovery-link">
        Start a custom project
        <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 shrink-0" aria-hidden="true" />
      </Link>
    </aside>
  );
}
