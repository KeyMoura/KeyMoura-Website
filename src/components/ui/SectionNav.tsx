"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isNavItemActive, type NavItem } from "@/lib/navigation";

/**
 * Primary section navigation: "which part of this area am I in".
 *
 * ## The distinction this component exists to hold
 *
 * The site had four tab-shaped things and no agreement between them. The
 * account's tabs were filled pills in the brand colour. The order filters are an
 * enclosed segmented control. Staff pages use `LinkTabs`. Catalog filters are
 * chips. Same silhouette, four different meanings, and nothing said which was
 * which.
 *
 * They are not all the same control and collapsing them into one component with
 * a `variant` prop would only move the confusion into a parameter. What they
 * needed was a *rule*, and the rule is what the thing does:
 *
 * - **Section navigation** — this — changes the URL to a different page. It is
 *   drawn like the site's main navbar: plain text, an underline under the
 *   current one, no enclosure. That is a deliberate borrow. A customer who has
 *   just used the header to get to their account should not have to learn a
 *   second visual language to move around inside it.
 * - **Segmented controls** (`SegmentedControl`, `LinkTabs`) filter or switch the
 *   *view* of one page. They stay enclosed, because an enclosure is what says
 *   "these options belong to the thing below them" — and the order filters
 *   already read well that way.
 * - **Filter chips** stay compact and removable.
 *
 * So the underline is not decoration here; it is what marks a control as
 * navigation rather than a filter. `tabs.test.ts` pins the three apart.
 *
 * ## Active state carries three signals, not one
 *
 * Colour, weight, and the rule underneath, plus `aria-current="page"`. An
 * underline on its own is a single cue that a low-contrast accent or a
 * forced-colours mode can erase, and the current section has to survive that.
 */
export function SectionNav({
  items,
  ariaLabel,
  className,
}: {
  items: readonly NavItem[];
  ariaLabel: string;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label={ariaLabel} className={`ui-section-nav${className ? ` ${className}` : ""}`}>
      {/*
        The scroller is inside the bordered shell rather than around it, so the
        rule under the strip runs the full width of the page at every size. A
        border on the scrolling element itself would end wherever the widest tab
        did and leave the underline floating.
      */}
      <div className="ui-section-nav-scroll">
        {items.map((item) => {
          const current = isNavItemActive(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={`ui-section-nav-link${current ? " is-active" : ""}`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
