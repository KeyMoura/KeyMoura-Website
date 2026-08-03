import type { Metadata } from "next";
import Link from "next/link";
import ProductImage from "@/components/ProductImage";
import { loadSharedCart } from "@/lib/commerce/sharedCartService";
import SharedCartActions from "./SharedCartActions";

/**
 * A shared cart, as seen by whoever holds the link.
 *
 * This is a snapshot, not a window onto someone's live cart. Prices and
 * availability are re-resolved from the catalog on every view and compared
 * against what was recorded when the link was made, so the page can be honest
 * about what has moved rather than quietly showing stale numbers.
 */

export const dynamic = "force-dynamic";

// Strong token, but not a secret worth indexing. Keep shared carts out of
// crawlers entirely.
export const metadata: Metadata = {
  title: "A shared cart",
  robots: { index: false, follow: false },
};

function money(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}

export default async function SharedCartPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await loadSharedCart(token);

  if (!shared) {
    return (
      <main className="page-container">
        <div className="ui-empty-state mt-8 !p-10">
          <h1 className="text-xl font-semibold text-brand-text">This cart link is not available.</h1>
          <p className="mt-2">
            The link may have expired or been revoked. Ask whoever sent it for a new one.
          </p>
          <div className="ui-action-row mt-5 justify-center">
            <Link href="/catalog" className="ui-btn ui-btn-primary">
              Browse the catalog
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const buyable = shared.lines.filter((line) => line.cartEligible);
  const changed = shared.lines.filter((line) => line.priceChanged);
  const unavailable = shared.lines.filter((line) => !line.cartEligible);

  return (
    <main className="page-container">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">A shared cart</h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Someone shared this list of {shared.lines.length} item{shared.lines.length === 1 ? "" : "s"} with you on{" "}
          {new Date(shared.sharedAt).toLocaleDateString()}. It is a snapshot, not their live cart, and everything below
          was re-checked against the catalog just now.
          {shared.expiresAt ? ` This link expires on ${new Date(shared.expiresAt).toLocaleDateString()}.` : ""}
        </p>
        {shared.note ? <p className="mt-3 leading-7 text-brand-text">“{shared.note}”</p> : null}
      </header>

      {changed.length ? (
        <p role="status" className="ui-notice ui-notice-warning mt-6">
          {changed.length === 1 ? "One item has" : `${changed.length} items have`} changed price since this list was
          shared. The current price is shown for each.
        </p>
      ) : null}

      {unavailable.length ? (
        <p role="status" className="ui-notice ui-notice-info mt-4">
          {unavailable.length === 1 ? "One item is" : `${unavailable.length} items are`} no longer available to buy
          outright. {unavailable.length === 1 ? "It is" : "They are"} marked below and will not be copied to your cart.
        </p>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
        <section aria-labelledby="shared-cart-items" className="ui-card">
          <h2 id="shared-cart-items" className="sr-only">
            Items on this list
          </h2>

          <ul className="divide-y divide-[var(--border)]">
            {shared.lines.map((line, index) => (
              <li
                key={`${line.productId}-${index}`}
                className="flex flex-wrap items-start gap-4 py-4 first:pt-0"
              >
                <ProductImage product={line.image} alt="" sizes="80px" className="wishlist-thumb" />

                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold">
                    {line.removed || !line.slug ? (
                      <span className="text-brand-textMuted">{line.name}</span>
                    ) : (
                      <Link href={`/catalog/${line.slug}`} className="hover:text-brand-primary">
                        {line.name}
                      </Link>
                    )}
                  </h3>

                  {line.optionLabels.length ? (
                    <ul className="mt-1 text-sm text-brand-textMuted">
                      {line.optionLabels.map((option) => (
                        <li key={option.group}>
                          {option.group}: {option.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="mt-1 text-sm text-brand-textMuted">
                    Quantity {line.quantity}
                    {line.unitPriceCents == null ? null : <> · {money(line.unitPriceCents)} each</>}
                  </p>

                  {line.priceChanged && line.unitPriceCents != null ? (
                    <p className="mt-1 text-sm text-amber-200">
                      Was {money(line.snapshotUnitPriceCents)} when shared, now {money(line.unitPriceCents)}.
                    </p>
                  ) : null}

                  {line.blockedMessage ? (
                    <p className="mt-2 text-sm text-amber-200">{line.blockedMessage}</p>
                  ) : null}

                  {line.cartEligible ? (
                    <SharedCartActions token={token} productId={line.productId} productName={line.name} />
                  ) : line.canRequest && line.slug ? (
                    <div className="ui-action-row mt-3">
                      <Link href={`/catalog/${line.slug}`} className="ui-btn ui-btn-secondary !py-1.5 text-sm">
                        Request a quote
                      </Link>
                    </div>
                  ) : null}
                </div>

                {line.lineSubtotalCents == null ? null : (
                  <p className="text-lg font-semibold">{money(line.lineSubtotalCents)}</p>
                )}
              </li>
            ))}
          </ul>
        </section>

        <aside className="ui-card lg:sticky lg:top-24">
          <h2 className="text-lg font-semibold">Copy to your cart</h2>

          <div className="mt-4 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-brand-textMuted">Available now</span>
              <span className="font-medium">{money(shared.currentSubtotalCents)}</span>
            </div>
            {shared.currentSubtotalCents !== shared.snapshotSubtotalCents ? (
              <div className="flex items-center justify-between">
                <span className="text-brand-textMuted">When shared</span>
                <span className="font-medium text-brand-textMuted">{money(shared.snapshotSubtotalCents)}</span>
              </div>
            ) : null}
          </div>

          <p className="mt-4 text-sm text-brand-textMuted">
            {buyable.length
              ? `${buyable.length} of ${shared.lines.length} item${shared.lines.length === 1 ? "" : "s"} can be copied. Prices are confirmed again as they are added.`
              : "None of these items can be bought outright right now."}
          </p>

          {buyable.length ? (
            <SharedCartActions token={token} productName="every available item" bulk className="mt-4" />
          ) : null}

          <p className="mt-4 text-xs text-brand-textMuted">
            Shipping and tax are calculated at checkout.
          </p>
        </aside>
      </div>
    </main>
  );
}
