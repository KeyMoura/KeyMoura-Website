"use client";

import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { useWishlist } from "@/lib/hooks/useWishlist";

/**
 * The navbar wishlist button.
 *
 * A link rather than a drawer: unlike the cart there is nothing to adjust in
 * passing, and a second popover competing with the cart's would be noise. Uses
 * the dedicated navbar utility colors so Appearance keeps control of the navbar
 * and this control never drifts from the bell and cart beside it.
 */

export default function WishlistIndicator() {
  const { data: wishlist } = useWishlist();
  const itemCount = wishlist?.itemCount ?? 0;

  return (
    <Link
      href="/wishlist"
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full border text-sm site-nav-utility${
        itemCount > 0 ? " is-highlighted" : ""
      }`}
      aria-label={itemCount === 1 ? "Wishlist, 1 item" : `Wishlist, ${itemCount} items`}
    >
      <FontAwesomeIcon icon={faHeart} className="text-[14px]" />
      {itemCount > 0 ? (
        <span
          aria-hidden="true"
          className="site-nav-utility-badge absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border px-1 text-[10px] font-bold"
        >
          {itemCount > 9 ? "9+" : itemCount}
        </span>
      ) : null}
    </Link>
  );
}
