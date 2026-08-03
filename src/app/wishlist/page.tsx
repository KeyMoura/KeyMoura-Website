"use client";

import Link from "next/link";
import { useState } from "react";
import ProductImage from "@/components/ProductImage";
import { formatCents } from "@/lib/hooks/useCart";
import { useWishlist, useWishlistMutations } from "@/lib/hooks/useWishlist";

/**
 * The wishlist page.
 *
 * Every entry is annotated by the server with whether it can go straight into a
 * cart and, when it cannot, why. Nothing is hidden: a made-to-order piece and a
 * discontinued one both stay visible, each with the action that actually
 * applies to it.
 */

const EXPIRY_CHOICES = [
  { label: "No expiry", value: "" },
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
] as const;

export default function WishlistPage() {
  const { data: wishlist, isLoading, isError, refetch } = useWishlist();
  const { remove, clear, moveToCart, share, revokeShare } = useWishlistMutations();

  const [expiry, setExpiry] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");

  const items = wishlist?.items ?? [];
  const eligible = wishlist?.cartEligibleCount ?? 0;
  const activeShare = wishlist?.share ?? null;

  const mutationError =
    remove.error?.message ||
    clear.error?.message ||
    moveToCart.error?.message ||
    share.error?.message ||
    revokeShare.error?.message ||
    "";

  function createShare() {
    setCopied(false);
    setNotice("");
    share.mutate(
      { expiresInDays: expiry ? Number(expiry) : null },
      { onSuccess: (result) => setShareUrl(result.url) }
    );
  }

  async function copyShareLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the input below still holds the URL and
      // stays selectable, so the link is never unreachable.
      setCopied(false);
      setNotice("Copy was blocked by your browser. Select the link and copy it manually.");
    }
  }

  function moveAll(mode: "move" | "copy") {
    setNotice("");
    moveToCart.mutate(
      { all: true, mode },
      {
        onSuccess: (result) => {
          const failed = result.failures.length ? ` ${result.failures.length} could not be added.` : "";
          setNotice(`${result.moved} item${result.moved === 1 ? "" : "s"} added to your cart.${failed}`);
        },
      }
    );
  }

  if (isLoading) {
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">Your wishlist</h1>
        <p aria-live="polite" className="mt-6 text-sm text-brand-textMuted">
          Loading your wishlist…
        </p>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="page-container">
        <h1 className="text-3xl font-semibold tracking-tight">Your wishlist</h1>
        <p role="alert" className="ui-notice ui-notice-danger mt-6">
          Your wishlist could not be loaded.
        </p>
        <button type="button" onClick={() => void refetch()} className="ui-btn ui-btn-secondary mt-4">
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="page-container">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Your wishlist</h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Saved items are checked against the live catalog every time this page loads, so prices and availability here
          are current.
        </p>
      </header>

      {mutationError ? (
        <p role="alert" className="ui-notice ui-notice-danger mt-6">
          {mutationError}
        </p>
      ) : null}

      {notice ? (
        <p role="status" aria-live="polite" className="ui-notice ui-notice-success mt-6">
          {notice}
        </p>
      ) : null}

      {!items.length ? (
        <div className="ui-empty-state mt-8 !p-10">
          <h2 className="text-xl font-semibold text-brand-text">Nothing saved yet.</h2>
          <p className="mt-2">Save anything in the catalog to come back to it later, whether or not it is in stock.</p>
          <div className="ui-action-row mt-5 justify-center">
            <Link href="/catalog" className="ui-btn ui-btn-primary">
              Browse the catalog
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_20rem] lg:items-start">
          <section aria-labelledby="wishlist-items" className="ui-card">
            <h2 id="wishlist-items" className="sr-only">
              Saved items
            </h2>

            <ul className="divide-y divide-[var(--border)]">
              {items.map((item) => (
                <li key={item.itemId} className="flex flex-wrap items-start gap-4 py-4 first:pt-0">
                  {/* Decorative: the product name is right beside it as a link,
                      so alt text here would just repeat the next element. */}
                  <ProductImage product={item.image} alt="" sizes="80px" className="wishlist-thumb" />

                  <div className="min-w-0 flex-1">
                    <h3 className="text-base font-semibold">
                      {item.removed || !item.slug ? (
                        <span className="text-brand-textMuted">{item.name}</span>
                      ) : (
                        <Link href={`/catalog/${item.slug}`} className="hover:text-brand-primary">
                          {item.name}
                        </Link>
                      )}
                    </h3>

                    {item.optionLabels.length ? (
                      <ul className="mt-1 text-sm text-brand-textMuted">
                        {item.optionLabels.map((option) => (
                          <li key={option.group}>
                            {option.group}: {option.label}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <p className="mt-1 text-sm text-brand-textMuted">
                      {item.unitPriceCents == null ? "Priced after review" : `${formatCents(item.unitPriceCents)} each`}
                    </p>

                    {item.blockedMessage ? (
                      <p className="mt-2 text-sm text-amber-200">{item.blockedMessage}</p>
                    ) : null}

                    <div className="ui-action-row mt-3">
                      {item.cartEligible ? (
                        <button
                          type="button"
                          disabled={moveToCart.isPending}
                          onClick={() =>
                            moveToCart.mutate(
                              { itemId: item.itemId, mode: "move" },
                              { onSuccess: () => setNotice(`${item.name} moved to your cart.`) }
                            )
                          }
                          className="ui-btn ui-btn-primary !py-1.5 text-sm disabled:opacity-50"
                        >
                          Move to cart
                        </button>
                      ) : item.canRequest && item.slug ? (
                        <Link href={`/catalog/${item.slug}`} className="ui-btn ui-btn-secondary !py-1.5 text-sm">
                          Request a quote
                        </Link>
                      ) : null}

                      <button
                        type="button"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate({ itemId: item.itemId })}
                        className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-50"
                      >
                        <span aria-hidden="true">Remove</span>
                        <span className="sr-only">Remove {item.name} from your wishlist</span>
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="ui-action-row mt-4 justify-between">
              <Link href="/catalog" className="ui-btn ui-btn-ghost text-sm">
                Keep browsing
              </Link>
              <button
                type="button"
                disabled={clear.isPending}
                onClick={() => clear.mutate()}
                className="ui-btn ui-btn-ghost text-sm disabled:opacity-50"
              >
                Clear wishlist
              </button>
            </div>
          </section>

          <aside className="grid gap-6 lg:sticky lg:top-24">
            <section aria-labelledby="wishlist-actions" className="ui-card">
              <h2 id="wishlist-actions" className="text-lg font-semibold">
                Move to cart
              </h2>
              <p className="mt-2 text-sm text-brand-textMuted">
                {eligible === 0
                  ? "None of your saved items can be bought outright yet. Made-to-order pieces go through a request."
                  : `${eligible} of ${items.length} saved item${items.length === 1 ? "" : "s"} can be bought outright.`}
              </p>

              {eligible > 0 ? (
                <div className="mt-4 grid gap-2">
                  <button
                    type="button"
                    disabled={moveToCart.isPending}
                    onClick={() => moveAll("move")}
                    className="ui-btn ui-btn-primary w-full disabled:opacity-50"
                  >
                    {moveToCart.isPending ? "Moving…" : "Move all to cart"}
                  </button>
                  <button
                    type="button"
                    disabled={moveToCart.isPending}
                    onClick={() => moveAll("copy")}
                    className="ui-btn ui-btn-ghost w-full text-sm disabled:opacity-50"
                  >
                    Copy to cart and keep saved
                  </button>
                </div>
              ) : null}
            </section>

            <section aria-labelledby="wishlist-share" className="ui-card">
              <h2 id="wishlist-share" className="text-lg font-semibold">
                Share this list
              </h2>
              <p className="mt-2 text-sm text-brand-textMuted">
                A share link shows only the products on this list. It never shows your name, your email, or anything
                else about your account.
              </p>

              {activeShare ? (
                <div className="mt-4">
                  <p className="text-sm text-emerald-300">
                    Sharing is on
                    {activeShare.expiresAt
                      ? ` until ${new Date(activeShare.expiresAt).toLocaleDateString()}`
                      : " with no expiry"}
                    .
                  </p>

                  <label className="ui-label mt-3 block" htmlFor="wishlist-share-url">
                    Share link
                  </label>
                  <input
                    id="wishlist-share-url"
                    readOnly
                    value={shareUrl || `${typeof window === "undefined" ? "" : window.location.origin}/wishlist/shared/${activeShare.token}`}
                    onFocus={(event) => event.currentTarget.select()}
                    className="ui-input mt-1 w-full text-xs"
                  />

                  <div className="ui-action-row mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        void copyShareLink(
                          shareUrl || `${window.location.origin}/wishlist/shared/${activeShare.token}`
                        )
                      }
                      className="ui-btn ui-btn-secondary !py-1.5 text-sm"
                    >
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <button
                      type="button"
                      disabled={revokeShare.isPending}
                      onClick={() => {
                        setShareUrl("");
                        setCopied(false);
                        revokeShare.mutate();
                      }}
                      className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-50"
                    >
                      Stop sharing
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <label className="ui-label block" htmlFor="wishlist-share-expiry">
                    Link expires
                  </label>
                  <select
                    id="wishlist-share-expiry"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                    className="ui-input mt-1 w-full"
                  >
                    {EXPIRY_CHOICES.map((choice) => (
                      <option key={choice.label} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={share.isPending}
                    onClick={createShare}
                    className="ui-btn ui-btn-secondary mt-3 w-full disabled:opacity-50"
                  >
                    {share.isPending ? "Creating…" : "Create a share link"}
                  </button>
                </div>
              )}
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
