"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import {
  clearRecentlyViewed,
  recentlyViewedServerSnapshot,
  recentlyViewedSnapshot,
  rememberRecentProduct,
  subscribeRecentlyViewed,
  type RecentProduct,
} from "@/lib/commerce/recentlyViewed";

/**
 * The recently-viewed strip, and the recorder that feeds it.
 *
 * One component with two modes rather than two files, because they share the
 * storage rules and there is no version of this where one is correct and the
 * other is not.
 *
 * ## Why `useSyncExternalStore` and not `useState` in an effect
 *
 * The list lives in `localStorage`, which the server cannot read. Reading it
 * into state inside an effect works, and has two problems this avoids:
 *
 *   - The server would render one thing and the client another. The store's
 *     server snapshot is a stable empty array, so the strip is absent on the
 *     server and absent on first paint, then appears below content the customer
 *     has to scroll to reach anyway. Nothing moves under them.
 *   - The recorder and the strip would not agree. On a product page both are
 *     mounted: opening the product writes the list, and every subscriber
 *     re-renders, so the strip below is current rather than one visit stale.
 *
 * A customer with no history sees nothing at all. An empty "Recently viewed"
 * heading is a promise the shop has not kept.
 */

type RecentlyViewedProps =
  | { mode: "record"; product: RecentProduct }
  | { mode: "list"; /** Never show the product you are currently looking at. */ excludeId?: string };

export default function RecentlyViewed(props: RecentlyViewedProps) {
  const items = useSyncExternalStore(
    subscribeRecentlyViewed,
    recentlyViewedSnapshot,
    recentlyViewedServerSnapshot
  );

  const recording = props.mode === "record";
  // Serialized so the effect re-runs when the product genuinely changes, rather
  // than on every render because the parent rebuilt the object literal.
  const productKey = recording ? JSON.stringify(props.product) : null;

  useEffect(() => {
    if (!productKey) return;
    rememberRecentProduct(JSON.parse(productKey) as RecentProduct);
  }, [productKey]);

  // The recorder is invisible: its whole job is the write above.
  if (recording) return null;

  const excludeId = props.mode === "list" ? props.excludeId : undefined;
  const visible = items.filter((item) => item.id !== excludeId);
  if (!visible.length) return null;

  return (
    <section className="recently-viewed" aria-labelledby="recently-viewed-heading">
      <div className="recently-viewed-head">
        <h2 id="recently-viewed-heading" className="recently-viewed-title">
          Recently viewed
        </h2>
        {/*
          The customer can empty their own history without opening browser
          settings. It is their data, held on their device, and a feature that
          quietly accumulates a browsing record with no way to clear it is the
          thing this design was trying not to be.
        */}
        <button type="button" onClick={clearRecentlyViewed} className="recently-viewed-clear">
          Clear
        </button>
      </div>

      <ul className="recently-viewed-row">
        {visible.map((item) => (
          <li key={item.id}>
            <Link href={`/catalog/${item.slug}`} className="recently-viewed-item">
              <span className="recently-viewed-thumb" aria-hidden="true">
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="recently-viewed-thumb-fallback">KM</span>
                )}
              </span>
              <span className="recently-viewed-name">{item.name}</span>
              {item.price ? <span className="recently-viewed-price">{item.price}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
