import type { PermissionKey } from "./permissions.ts";

/**
 * The staff information architecture — one definition, read by everything.
 *
 * The desktop sidebar, the mobile drawer, the breadcrumbs, the page header and
 * the settings index all read this file. Before this pass the sidebar held one
 * list and `StaffContextBar` held a second, overlapping one; they had already
 * drifted, and `/staff/settings/commerce` appeared in neither — it was
 * reachable only by typing the URL, which is the failure mode this module
 * exists to make impossible.
 *
 * Deliberately pure and dependency-free (no React, no `next/*`), so the routing
 * rules below are testable as functions rather than only observable by
 * rendering a page.
 *
 * **Nothing is listed here that does not exist.** There are no placeholder
 * rows, no disabled "coming later" entries, and no group that renders empty.
 * Routes that are genuinely not built yet are recorded in the ledger, not in
 * the menu — a menu entry that goes nowhere costs a staff member the same click
 * every day and teaches them to distrust the rest of the list.
 */

/** Icon keys. Resolved to real icons in the component; kept as strings here so this module imports nothing. */
export type StaffNavIcon =
  | "dashboard"
  | "orders"
  | "truck"
  | "production"
  | "catalog"
  | "inventory"
  | "discount"
  | "analytics"
  | "reconcile"
  | "audit"
  | "users"
  | "moderation"
  | "community"
  | "shops"
  | "pending"
  | "updates"
  | "todo"
  | "settings"
  | "commerce"
  | "appearance"
  | "email"
  | "security"
  | "roles"
  | "recycle"
  | "perks";

export type StaffNavItem = {
  href: string;
  label: string;
  /** Shown in the drawer and on the settings index. One line, sentence case. */
  description: string;
  icon: StaffNavIcon;
  /**
   * Visible when the viewer holds *any* of these. An item with no list is
   * visible to every staff member who can reach `/staff` at all.
   */
  anyOf?: readonly PermissionKey[];
  /**
   * Extra path prefixes this item owns for active-state purposes — for routes
   * that live outside their own subtree. `/staff/orders` owns `/staff/orders/…`
   * by prefix already; this is for the cases that prefix matching cannot see.
   */
  alsoOwns?: readonly string[];
};

export type StaffNavGroup = {
  id: string;
  label: string;
  /** A group whose items are all hidden is not rendered; see `visibleStaffNav`. */
  items: readonly StaffNavItem[];
};

/**
 * Permissions that let somebody see the staff area at all.
 *
 * Used by the layout to decide between the navigation and a refusal, and by the
 * dashboard. It is derived from the navigation rather than hand-maintained, so
 * adding a section cannot leave its holders locked out of the shell.
 */
export const STAFF_NAV: readonly StaffNavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        href: "/staff",
        label: "Dashboard",
        description: "What needs attention right now, across the whole shop.",
        icon: "dashboard",
      },
      {
        href: "/staff/info/todo",
        label: "To-do board",
        description: "Shared staff tasks and who is carrying them.",
        icon: "todo",
        anyOf: ["todo.view"],
      },
    ],
  },
  {
    id: "commerce",
    label: "Commerce",
    items: [
      {
        href: "/staff/orders",
        label: "Orders",
        description: "Requests, quotes, payments, cancellations, returns and refunds.",
        icon: "orders",
        anyOf: ["orders.view", "orders.manage"],
      },
      {
        href: "/staff/fulfillment",
        label: "Fulfillment",
        description: "Everything waiting to be packed, collected, shipped or confirmed.",
        icon: "truck",
        anyOf: ["fulfillment.view", "fulfillment.manage"],
      },
      {
        href: "/staff/production",
        label: "Production",
        description: "The workshop queue, job workspaces and printable travellers.",
        icon: "production",
        anyOf: ["production.view", "production.manage"],
      },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    items: [
      {
        href: "/staff/catalog",
        label: "Products",
        description: "Product details, media, options, shipping and stock rules.",
        icon: "catalog",
        anyOf: ["catalog.view", "catalog.manage"],
      },
      {
        href: "/staff/catalog/categories",
        label: "Categories",
        description: "The storefront browse menu: categories, subcategories and order.",
        icon: "catalog",
        anyOf: ["catalog.categories.manage"],
      },
      {
        href: "/staff/catalog/discounts",
        label: "Discount codes",
        description: "Codes, targeting, limits and the redemption report.",
        icon: "discount",
        anyOf: ["catalog.discounts.manage"],
      },
      {
        href: "/staff/inventory",
        label: "Inventory",
        description: "On hand, reserved and available stock, with every movement.",
        icon: "inventory",
        anyOf: ["inventory.view", "inventory.manage"],
      },
    ],
  },
  {
    id: "people",
    label: "Customers & content",
    items: [
      {
        href: "/staff/security/users",
        label: "Customers & users",
        description: "Accounts, roles, verification and account status.",
        icon: "users",
        // The legacy `/staff/info/users` route redirects here; owning it keeps
        // the sidebar highlighted for the instant before the redirect lands.
        alsoOwns: ["/staff/info/users"],
        anyOf: ["users.view"],
      },
      {
        href: "/staff/moderation/reports",
        label: "Reports & moderation",
        description: "The report queue, escalations and moderation decisions.",
        icon: "moderation",
        alsoOwns: ["/staff/moderation"],
        anyOf: ["moderation.reports.view"],
      },
      {
        href: "/staff/community",
        label: "Community",
        description: "Threads, categories and community configuration.",
        icon: "community",
        anyOf: ["community.view"],
      },
      {
        href: "/staff/shops",
        label: "Shops",
        description: "Partner shops and their published listings.",
        icon: "shops",
        anyOf: ["shops.view"],
      },
      {
        href: "/staff/info/pending",
        label: "Pending submissions",
        description: "Community-submitted pages waiting for review.",
        icon: "pending",
        anyOf: ["info.pending.view"],
      },
      {
        href: "/staff/info/updates",
        label: "Content updates",
        description: "Proposed edits to existing pages waiting for review.",
        icon: "updates",
        anyOf: ["info.updates.view"],
      },
    ],
  },
  {
    id: "business",
    label: "Business",
    items: [
      {
        href: "/staff/info/analytics",
        label: "Analytics",
        description: "Revenue, orders and site metrics over time.",
        icon: "analytics",
        anyOf: ["analytics.view"],
      },
      {
        href: "/staff/reconciliation",
        label: "Reconciliation",
        description: "Payments, refunds, stock and holds checked against each other.",
        icon: "reconcile",
        anyOf: ["orders.view", "orders.manage", "inventory.view", "refunds.issue"],
      },
      {
        href: "/staff/integrations",
        label: "Integration health",
        description: "Database, Stripe, email, analytics and sign-in, with what is proven and what is assumed.",
        icon: "reconcile",
        anyOf: ["operations.health.view"],
      },
      {
        href: "/staff/launch-readiness",
        label: "Launch readiness",
        description: "What would stop this shop taking a real order today.",
        icon: "settings",
        anyOf: ["launch.readiness.view", "operations.health.view"],
      },
      {
        href: "/staff/security/audit",
        label: "Audit log",
        description: "Sensitive staff and system actions, newest first.",
        icon: "audit",
        anyOf: ["audit.view", "audit.read"],
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        href: "/staff/settings",
        label: "Settings overview",
        description: "Every configuration surface, grouped.",
        icon: "settings",
        anyOf: [
          "commerce.settings.view",
          "commerce.settings.manage",
          "appearance.manage",
          "emails.manage",
          "emails.view",
          "security.view",
          "roles.view",
          "audit.view",
          "audit.read",
          "recycle_bin.view",
        ],
      },
      {
        href: "/staff/settings/commerce",
        label: "Shipping, pickup & policy",
        description: "Delivery methods and prices, local pickup, stock rules, returns policy.",
        icon: "commerce",
        anyOf: ["commerce.settings.view", "commerce.settings.manage"],
      },
      {
        href: "/staff/appearance",
        label: "Appearance",
        description: "Brand identity, colours, typography and control styles.",
        icon: "appearance",
        anyOf: ["appearance.manage"],
      },
      {
        href: "/staff/emails",
        label: "Email & notifications",
        description: "Sender details, templates, staff alerts and delivery history.",
        icon: "email",
        anyOf: ["emails.manage", "emails.view", "emails.resend"],
      },
      {
        href: "/staff/security",
        label: "Security controls",
        description: "Maintenance mode, lockdown, IP restrictions and emergency messaging.",
        icon: "security",
        anyOf: ["security.view"],
      },
      {
        href: "/staff/security/roles",
        label: "Roles & permissions",
        description: "Which staff roles can view and manage each area.",
        icon: "roles",
        anyOf: ["roles.view"],
      },
      {
        href: "/staff/security/verified-perks",
        label: "Verified perks",
        description: "Bonus permissions granted to verified members.",
        icon: "perks",
        anyOf: ["security.verified_perks.manage"],
      },
      {
        href: "/staff/security/recycle-bin",
        label: "Recycle bin",
        description: "Soft-deleted content awaiting expiry, and restores.",
        icon: "recycle",
        anyOf: ["recycle_bin.view"],
      },
    ],
  },
];

/** Every item, flattened. Order is the order it is displayed in. */
export const STAFF_NAV_ITEMS: readonly StaffNavItem[] = STAFF_NAV.flatMap((group) => group.items);

/**
 * The union of every permission that opens some staff destination.
 *
 * Derived, not hand-written: a new section cannot ship with its holders unable
 * to reach the shell that contains it.
 */
export const STAFF_AREA_PERMISSIONS: readonly PermissionKey[] = [
  ...new Set(STAFF_NAV_ITEMS.flatMap((item) => item.anyOf ?? [])),
];

const hasAny = (permissions: ReadonlySet<string>, required?: readonly string[]) =>
  !required?.length || required.some((permission) => permissions.has(permission));

/** True when this viewer can reach at least one staff destination beyond the dashboard. */
export function canUseStaffArea(permissions: ReadonlySet<string>): boolean {
  return STAFF_AREA_PERMISSIONS.some((permission) => permissions.has(permission));
}

/**
 * The navigation this viewer may see.
 *
 * Filtering happens once, here. A group with nothing left in it is dropped
 * rather than rendered as an empty heading, and the dashboard row is dropped
 * along with everything else when the viewer holds no staff permission at all —
 * a sidebar offering exactly one link to a page that refuses them is worse than
 * no sidebar.
 */
export function visibleStaffNav(permissions: ReadonlySet<string>): StaffNavGroup[] {
  if (!canUseStaffArea(permissions)) return [];
  return STAFF_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => hasAny(permissions, item.anyOf)),
  })).filter((group) => group.items.length > 0);
}

/** Every href this viewer may follow — used to prove the menu never offers a refusal. */
export function visibleStaffHrefs(permissions: ReadonlySet<string>): string[] {
  return visibleStaffNav(permissions).flatMap((group) => group.items.map((item) => item.href));
}

/** True when `pathname` is `prefix` or lives under it. Never matches a sibling like `/staff/ordersXYZ`. */
function ownsPath(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * How long a claim an item has on this path, or -1 for none.
 *
 * **Longest prefix wins**, which is one rule instead of a per-item `exact` flag.
 * It is what makes `/staff/catalog/discounts` highlight Discount codes rather
 * than Products, `/staff/settings/commerce` highlight itself rather than
 * Settings overview, and `/staff` highlight only the dashboard instead of
 * every row in the sidebar — the previous behaviour needed three hand-written
 * exceptions and still got `/staff/catalog/discounts` wrong.
 */
function claimLength(item: StaffNavItem, pathname: string): number {
  const prefixes = [item.href, ...(item.alsoOwns ?? [])];
  let best = -1;
  for (const prefix of prefixes) {
    if (ownsPath(prefix, pathname) && prefix.length > best) best = prefix.length;
  }
  return best;
}

export type StaffNavMatch = { group: StaffNavGroup; item: StaffNavItem };

/** The single navigation entry that owns this path, or null when nothing does. */
export function activeStaffNavItem(pathname: string): StaffNavMatch | null {
  let match: StaffNavMatch | null = null;
  let best = -1;
  for (const group of STAFF_NAV) {
    for (const item of group.items) {
      const length = claimLength(item, pathname);
      if (length > best) {
        best = length;
        match = { group, item };
      }
    }
  }
  return match;
}

/** True when this item should be marked `aria-current="page"` for the given path. */
export function isStaffNavItemActive(item: StaffNavItem, pathname: string): boolean {
  return activeStaffNavItem(pathname)?.item.href === item.href;
}

/** True when a group contains the active item — used to auto-open a collapsed group. */
export function isStaffNavGroupActive(group: StaffNavGroup, pathname: string): boolean {
  return activeStaffNavItem(pathname)?.group.id === group.id;
}

export type StaffCrumb = { href: string; label: string; current: boolean };

/**
 * Leaf labels for the routes that sit *under* a navigation entry.
 *
 * Only routes whose own page cannot supply a better name are listed. A record
 * detail page (`/staff/orders/<id>`) deliberately gets the generic word rather
 * than the record's title: the breadcrumb renders before the record loads, and
 * a crumb that changes from "Order" to a product name after a beat moves the
 * page under the reader.
 */
const LEAF_LABELS: Readonly<Record<string, string>> = {
  "/staff/orders/new": "New proposal",
  "/staff/production/new": "New job",
  "/staff/emails/deliveries": "Delivery history",
  "/staff/launch-readiness/discrepancies": "Payment discrepancies",
};

const LEAF_PATTERNS: readonly { test: RegExp; label: string }[] = [
  { test: /^\/staff\/orders\/[^/]+\/print\/[^/]+$/, label: "Printable document" },
  { test: /^\/staff\/orders\/[^/]+$/, label: "Order" },
  { test: /^\/staff\/production\/[^/]+\/print$/, label: "Printable documents" },
  { test: /^\/staff\/production\/[^/]+$/, label: "Job" },
  { test: /^\/staff\/inventory\/[^/]+$/, label: "Product stock" },
  { test: /^\/staff\/info\/pending\/[^/]+$/, label: "Submission" },
  { test: /^\/staff\/info\/updates\/[^/]+$/, label: "Update" },
];

/**
 * The trail for a staff path: Staff → group → destination → (leaf).
 *
 * The group crumb is **not** a link. Groups are organisational, not
 * destinations — linking one to the first page inside it, which is what the old
 * context bar did, sends a reader somewhere they did not ask to go.
 */
export function staffBreadcrumbs(pathname: string): StaffCrumb[] {
  const match = activeStaffNavItem(pathname);
  if (!match) return [{ href: "/staff", label: "Staff", current: pathname === "/staff" }];

  const crumbs: StaffCrumb[] = [{ href: "/staff", label: "Staff", current: false }];
  if (match.item.href === "/staff") {
    crumbs[0].current = true;
    return crumbs;
  }

  crumbs.push({ href: "", label: match.group.label, current: false });

  const isLeaf = pathname !== match.item.href;
  crumbs.push({ href: match.item.href, label: match.item.label, current: !isLeaf });

  if (isLeaf) {
    const label =
      LEAF_LABELS[pathname] ?? LEAF_PATTERNS.find((pattern) => pattern.test.test(pathname))?.label ?? null;
    // An unlabelled leaf gets no crumb rather than a guessed one. A trail that
    // stops at the section is honest; a trail ending in a slug is not.
    if (label) crumbs.push({ href: pathname, label, current: true });
    else crumbs[crumbs.length - 1].current = true;
  }

  return crumbs;
}
