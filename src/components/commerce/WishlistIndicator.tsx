"use client";

import Link from "next/link";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faHeart } from "@fortawesome/free-solid-svg-icons";
import { badgeCount, badgeLabel } from "@/lib/navBadge";
import { useWishlist } from "@/lib/hooks/useWishlist";

/**
 * The navbar wishlist button.
 *
 * A link rather than a drawer: unlike the cart there is nothing to adjust in
 * passing, and a second popover competing with the cart's would be noise. Uses
 * the dedicated navbar utility colors so Appearance keeps control of the navbar
 * and this control never drifts from the bell and cart beside it.
 *
 * The count bubble hangs from `site-nav-count-host`, which replaced a bare
 * Tailwind `relative` here. The behaviour is identical; what changed is that the
 * cart, the wishlist and the bell now say the same thing for the same reason
 * instead of three of them happening to be positioned and one not.
 */

export default function WishlistIndicator() {
  const { data: wishlist } = useWishlist();
  const itemCount = wishlist?.itemCount ?? 0;

  return (
    <Link
      href="/wishlist"
      className={`site-nav-count-host inline-flex h-9 w-9 items-center justify-center rounded-full border text-sm site-nav-utility${
        itemCount > 0 ? " is-highlighted" : ""
      }`}
      aria-label={badgeLabel("Wishlist", itemCount)}
    >
      <FontAwesomeIcon icon={faHeart} className="text-[14px]" />
      {badgeCount(itemCount) ? (
        <span className="site-nav-utility-badge site-nav-badge" aria-hidden="true">
          {badgeCount(itemCount)}
        </span>
      ) : null}
    </Link>
  );
}
