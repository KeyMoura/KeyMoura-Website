/**
 * The site's customer navigation, defined once.
 *
 * Every navigation surface — the desktop bar, its More menu, the mobile drawer,
 * the account menu, and the footer — is derived from the lists below. Before
 * this module the desktop bar built its links from two arrays in `SiteHeader`
 * while the mobile drawer hard-coded a second copy of the same six `<Link>`s a
 * few hundred lines further down. Adding a destination meant editing both, and
 * the two had already drifted: the drawer offered no Wishlist, no Orders and no
 * search, so a phone user could fill a wishlist and have no route back to it.
 *
 * A single list also makes the information architecture testable. `tests/
 * navigation-architecture.test.ts` asserts things like "Community is not in the
 * primary customer navigation" and "every mobile destination is reachable on
 * desktop" against these constants rather than against rendered markup.
 *
 * Nothing here is a permission check. `staffNavItems` decides what a staff
 * member is *shown*; every route behind it re-checks the permission on the
 * server, so hiding or showing a link cannot grant access.
 */

export type NavItem = {
  href: string;
  label: string;
  /** Shown in the mobile drawer and the More menu, where there is room to explain. */
  description?: string;
};

/**
 * The primary customer navigation.
 *
 * Ordered the way a customer arrives at the business: what you can buy, what
 * you can have made, proof that it gets made well, then who is making it.
 *
 * Community is deliberately absent — and as of pass 14 it is absent from every
 * other customer surface too. See the note on `secondaryNav`.
 */
export const primaryNav: readonly NavItem[] = [
  { href: "/catalog", label: "Products", description: "Ready designs and made-to-order parts" },
  { href: "/orders/new", label: "Custom Projects", description: "Send a drawing, CAD file, or description" },
  { href: "/projects", label: "Gallery", description: "Recent builds and write-ups" },
  { href: "/about", label: "About", description: "The shop, and how it works" },
] as const;

/**
 * Secondary destinations, reachable from the More menu on desktop and listed in
 * full in the mobile drawer.
 *
 * These are pages a customer visits once — reference material and a contact
 * form — rather than places they shop.
 *
 * **Community is dormant, not deleted.** KeyMoura is a shop today, and a
 * discussion area with no discussion in it is worse than no discussion area:
 * it invites a customer to a room where nobody answers. So it is removed from
 * every customer surface — this menu, the mobile drawer, the footer and the
 * search palette — while `/community` and every thread under it keeps working
 * for anyone holding a link, and every post, comment and category stays exactly
 * where it is. Nothing was dropped, archived or migrated.
 *
 * The pages are `noindex` while dormant, so search engines stop offering a
 * section the site no longer points at. Bringing it back is adding an entry
 * here and removing that directive; there is no data to restore.
 */
export const secondaryNav: readonly NavItem[] = [
  { href: "/capabilities", label: "Capabilities", description: "Materials, sizes, and limits" },
  { href: "/design-guide", label: "Design guide", description: "Tolerances and drawing tips" },
  { href: "/contact", label: "Contact", description: "Ask a question first" },
] as const;

/**
 * The account menu, for a signed-in customer.
 *
 * Messages lives here rather than on the bar. A dedicated message control in a
 * storefront header is a forum affordance: it competes for attention with the
 * cart, and it is the kind of thing a customer opens once a week, not once a
 * visit. The trigger still carries an unread dot, so nothing becomes
 * undiscoverable by moving.
 */
export const accountNav: readonly NavItem[] = [
  { href: "/account", label: "Account" },
  { href: "/orders", label: "Orders" },
  { href: "/orders?view=requests", label: "Requests" },
  { href: "/wishlist", label: "Wishlist" },
  { href: "/messages", label: "Messages" },
  { href: "/notifications", label: "Notifications" },
] as const;

/** Account-menu entries that sit below a divider: security, then sign out. */
export const accountSecondaryNav: readonly NavItem[] = [
  { href: "/account#security", label: "Security & connected accounts" },
] as const;

/**
 * The footer's business columns.
 *
 * Deliberately not a copy of the navbar. The header answers "where do I shop";
 * the footer answers "what are the terms" — the policy pages a customer looks
 * for before buying and cannot find in a header that has room for four links.
 */
export const footerNav: readonly { heading: string; items: readonly NavItem[] }[] = [
  {
    heading: "Shop",
    items: [
      { href: "/catalog", label: "Products" },
      { href: "/orders/new", label: "Custom projects" },
      { href: "/wishlist", label: "Wishlist" },
      { href: "/cart", label: "Cart" },
      { href: "/orders", label: "Your orders" },
    ],
  },
  {
    heading: "The shop",
    items: [
      { href: "/about", label: "About" },
      { href: "/capabilities", label: "Capabilities & materials" },
      { href: "/projects", label: "Gallery" },
      { href: "/design-guide", label: "Design & tolerance guide" },
    ],
  },
  {
    heading: "Support",
    items: [
      { href: "/contact", label: "Contact" },
      { href: "/shipping", label: "Shipping" },
      { href: "/refunds", label: "Returns & cancellations" },
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
] as const;

/**
 * Staff destinations, shown only to a staff session.
 *
 * Kept out of `primaryNav` on purpose: a staff link in the customer link row
 * reads as a store category to everyone who is not staff, and to staff it reads
 * as clutter on the surface they use least.
 */
export function staffNavItems(isStaff: boolean): readonly NavItem[] {
  return isStaff ? [{ href: "/staff", label: "Staff area", description: "Orders, catalog, production" }] : [];
}

/**
 * Whether a nav link should render as the current page.
 *
 * `/` matches only itself — every path starts with a slash, so a prefix test
 * would light the home link up everywhere.
 *
 * Query strings are compared when the item carries one, which is what keeps
 * "Orders" and "Requests" (`/orders` and `/orders?view=requests`) from both
 * appearing active on the same page.
 */
export function isNavItemActive(item: Pick<NavItem, "href">, pathname: string, search?: string): boolean {
  const [path, query] = item.href.split("?");

  if (path === "/") return pathname === "/";
  if (pathname !== path && !pathname.startsWith(`${path}/`)) return false;

  if (query) return (search ?? "").replace(/^\?/, "") === query;

  // A bare item is active only when no sibling query item claims the page.
  return true;
}

/** Every customer destination, used by tests to assert desktop/mobile parity. */
export function allCustomerNavHrefs(): string[] {
  return [...primaryNav, ...secondaryNav].map((item) => item.href);
}
