"use client";

import Link from "next/link";
import NavMenu from "@/components/nav/NavMenu";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import {
  accountNav,
  accountSecondaryNav,
  isNavItemActive,
  staffNavItems,
} from "@/lib/navigation";

/**
 * The signed-in customer's account menu.
 *
 * This is where the header stopped being a forum toolbar. Messages, staff
 * access and the account destinations used to be individual pills competing
 * with the cart for space on the bar; at 1280 with a staff session that cluster
 * needed 495px. They are all reachable from one control now.
 *
 * Staff access lives here rather than in the customer link row on purpose. In
 * the link row it reads as a store category to every customer who cannot use
 * it, and it is styled with the role's own colour, which made it the loudest
 * thing in a storefront header. Inside the menu it is clearly a different kind
 * of destination, and it is still one click from anywhere on the site.
 *
 * The trigger carries a dot when there is anything unread, so moving Messages
 * and Notifications off the bar does not make them undiscoverable. The dot is
 * decorative; the real count is announced in the accessible name and printed
 * beside each item.
 */

type AccountMenuProps = {
  triggerClassName: string;
  pathname: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  donationRank: string | null;
  isStaff: boolean;
  unreadMessages: number;
  unreadNotifications: number;
};

export default function AccountMenu({
  triggerClassName,
  pathname,
  displayName,
  email,
  avatarUrl,
  isVerified,
  donationRank,
  isStaff,
  unreadMessages,
  unreadNotifications,
}: AccountMenuProps) {
  const staffItems = staffNavItems(isStaff);

  const unreadTotal = unreadMessages + unreadNotifications;
  const label = displayName || email?.split("@")[0] || "Account";
  const initial = (displayName?.[0] || email?.[0] || "U").toUpperCase();

  const accessibleName = unreadTotal
    ? `Account menu for ${label}, ${unreadTotal} unread`
    : `Account menu for ${label}`;

  const countFor = (href: string) =>
    href === "/messages" ? unreadMessages : href === "/account/notifications" ? unreadNotifications : 0;

  return (
    <NavMenu
      triggerClassName={triggerClassName}
      triggerLabel={accessibleName}
      menuLabel="Account"
      isHighlighted={pathname.startsWith("/account")}
      align="right"
      /* Width and padding only — the panel's chrome is `.nav-menu-panel`, so
         this menu, More and the Products panel cannot drift apart again. */
      panelClassName="w-64 p-2"
      trigger={
        <>
          {/* The dot belongs to the avatar, not to the whole trigger, so the
              host is this wrapper rather than the button — an unread mark
              floating off the end of a name is not a mark on anything. */}
          <span className="site-nav-count-host inline-flex shrink-0">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="h-7 w-7 rounded-full border border-[color:var(--km-nav-util-border)] object-cover"
              />
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-primary/20 text-[10px] font-semibold text-brand-primary">
                {initial}
              </span>
            )}
            {unreadTotal > 0 ? <span className="site-nav-dot" aria-hidden="true" /> : null}
          </span>
          <span className="hidden max-w-[110px] truncate xl:inline 2xl:max-w-[140px]">
            {label}
            {isVerified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
            {donationRank ? <DonationBadge rank={donationRank} className="ml-0.5 h-3 w-3" /> : null}
          </span>
        </>
      }
    >
      <div className="nav-menu-headline">
        <p className="truncate text-[13px] font-semibold text-brand-text">{label}</p>
        {email ? <p className="truncate text-[11px] text-brand-textMuted">{email}</p> : null}
      </div>

      {accountNav.map((item) => {
        const count = countFor(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            role="menuitem"
            tabIndex={-1}
            aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
            className="nav-menu-item"
          >
            <span>{item.label}</span>
            {count > 0 ? <span className="nav-menu-count">{count > 99 ? "99+" : count}</span> : null}
          </Link>
        );
      })}

      <div className="nav-menu-divider" role="separator" />

      {accountSecondaryNav.map((item) => (
        <Link key={item.href} href={item.href} role="menuitem" tabIndex={-1} className="nav-menu-item">
          {item.label}
        </Link>
      ))}

      {staffItems.length ? (
        <>
          <div className="nav-menu-divider" role="separator" />
          {staffItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              tabIndex={-1}
              aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
              className="nav-menu-item nav-menu-item-staff"
            >
              {item.label}
            </Link>
          ))}
        </>
      ) : null}

      <div className="nav-menu-divider" role="separator" />

      <Link href="/auth/logout" role="menuitem" tabIndex={-1} className="nav-menu-item nav-menu-item-signout">
        Sign out
      </Link>
    </NavMenu>
  );
}
