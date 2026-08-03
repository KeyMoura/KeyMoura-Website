import type { Metadata } from "next";
import Link from "next/link";
import ProductImage from "@/components/ProductImage";
import { loadSharedWishlist } from "@/lib/commerce/wishlistService";
import SharedWishlistActions from "./SharedWishlistActions";

/**
 * A shared wishlist, as seen by whoever holds the link.
 *
 * Resolved on the server from the token alone. The page renders products and
 * nothing else — no name, no email, no account id, no wishlist id, and no
 * handle that would let a viewer write to the list they were shown.
 */

export const dynamic = "force-dynamic";

// A share link is private-by-obscurity: strong token, but not a secret worth
// putting in a search index. Keep every shared list out of crawlers entirely.
export const metadata: Metadata = {
  title: "A shared wishlist",
  robots: { index: false, follow: false },
};

export default async function SharedWishlistPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const shared = await loadSharedWishlist(token);

  if (!shared) {
    return (
      <main className="page-container">
        <div className="ui-empty-state mt-8 !p-10">
          <h1 className="text-xl font-semibold text-brand-text">This wishlist link is not available.</h1>
          <p className="mt-2">
            The link may have expired, or sharing may have been turned off. Ask whoever sent it for a new link.
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

  const available = shared.entries.filter((entry) => !entry.removed);
  const buyable = shared.entries.filter((entry) => entry.cartEligible);

  return (
    <main className="page-container">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">A shared wishlist</h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Someone shared these {shared.entries.length} item{shared.entries.length === 1 ? "" : "s"} with you. Prices and
          availability below were checked against the catalog just now.
          {shared.expiresAt ? ` This link expires on ${new Date(shared.expiresAt).toLocaleDateString()}.` : ""}
        </p>
      </header>

      {!available.length ? (
        <p className="ui-notice ui-notice-warning mt-6">
          None of the items on this list are available any more.
        </p>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_18rem] lg:items-start">
        <section aria-labelledby="shared-items" className="ui-card">
          <h2 id="shared-items" className="sr-only">
            Items on this list
          </h2>

          <ul className="divide-y divide-[var(--border)]">
            {shared.entries.map((entry) => (
              <li key={entry.itemId} className="flex flex-wrap items-start gap-4 py-4 first:pt-0">
                <ProductImage product={entry.image} alt="" sizes="80px" className="wishlist-thumb" />

                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold">
                    {entry.removed || !entry.slug ? (
                      <span className="text-brand-textMuted">{entry.name}</span>
                    ) : (
                      <Link href={`/catalog/${entry.slug}`} className="hover:text-brand-primary">
                        {entry.name}
                      </Link>
                    )}
                  </h3>

                  {entry.optionLabels.length ? (
                    <ul className="mt-1 text-sm text-brand-textMuted">
                      {entry.optionLabels.map((option) => (
                        <li key={option.group}>
                          {option.group}: {option.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="mt-1 text-sm text-brand-textMuted">
                    {entry.unitPriceCents == null ? "Priced after review" : `${formatPrice(entry.unitPriceCents)} each`}
                  </p>

                  {entry.blockedMessage ? (
                    <p className="mt-2 text-sm text-amber-200">{entry.blockedMessage}</p>
                  ) : null}

                  {!entry.removed ? (
                    <SharedWishlistActions
                      token={token}
                      productId={entry.productId}
                      productName={entry.name}
                      cartEligible={entry.cartEligible}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <aside className="ui-card lg:sticky lg:top-24">
          <h2 className="text-lg font-semibold">Take this list with you</h2>
          <p className="mt-2 text-sm text-brand-textMuted">
            Copy these items to your own wishlist or cart. Everything is re-checked against the catalog as it is
            copied, so you always get the current price.
          </p>

          <SharedWishlistActions
            token={token}
            productName="every available item"
            cartEligible={buyable.length > 0}
            bulk
            className="mt-4"
          />
        </aside>
      </div>
    </main>
  );
}

function formatPrice(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}
