import type { PermissionKey } from "./permissions.ts";

/**
 * The staff information architecture — one definition, read by everything.
 *
 * The desktop sidebar, the mobile drawer, the breadcrumbs and the settings
 * index all read this file. Deliberately pure and dependency-free (no React, no
 * `next/*`), so the routing rules below are testable as functions rather than
 * only observable by rendering a page.
 *
 * ## What changed in this pass, and why
 *
 * The sidebar listed **27 destinations across 8 groups, all of them expanded**.
 * Every feature the project had ever shipped had a button, and each button had
 * the same visual weight — so "Recycle bin" and "Orders" were presented as
 * equally likely places to be going. A staff member opening the shop in the
 * morning had to read 27 rows to find the four they use.
 *
 * The list is now split by **how often somebody actually needs it**:
 *
 * - **Primary** (`secondary: false`) — 16 destinations, always visible, grouped
 *   by the task rather than by the table they happen to read.
 * - **Secondary** (`secondary: true`) — the diagnostic, moderation and
 *   site-content tools, behind one collapsed "More tools" disclosure.
 *
 * Nothing was removed. Every route still exists, still has its permissions, and
 * is still reachable from the menu — the difference is that eleven of them no
 * longer compete with Orders for attention. Several also appear on the settings
 * index, which is derived from `settingsSection` below rather than from group
 * membership, so a tool can sit in "More tools" in the sidebar *and* under
 * "Access & safety" on `/staff/settings` without being listed twice.
 *
 * **Nothing is listed here that does not exist.** There are no placeholder
 * rows, no disabled "coming later" entries, and no group that renders empty.
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

/**
 * Subsections of the settings index.
 *
 * These are the four questions `/staff/settings` answers. An item earns a place
 * there by carrying `settingsSection`, wherever it sits in the sidebar.
 */
export type StaffSettingsSection = "store" | "design" | "access" | "system";

export const STAFF_SETTINGS_SECTIONS: readonly {
  id: StaffSettingsSection;
  label: string;
  description: string;
}[] = [
  { id: "store", label: "Store & checkout", description: "How orders are paid for, delivered and returned." },
  { id: "design", label: "Visual design", description: "What the storefront and the staff area look like." },
  { id: "access", label: "Access & safety", description: "Who can do what, and how the site behaves in an emergency." },
  { id: "system", label: "System", description: "Housekeeping, recovery and the record of what was done." },
];

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
   * Which block of the settings index this belongs to. Read independently of
   * which sidebar group the item is in, so a tool can be secondary in the
   * sidebar and still be a first-class row under Settings.
   */
  settingsSection?: StaffSettingsSection;
  /**
   * Extra path prefixes this item owns for active-state purposes — for routes
   * that live outside their own subtree. `/staff/orders` owns `/staff/orders/…`
   * by prefix already; this is for the cases prefix matching cannot see.
   */
  alsoOwns?: readonly string[];
};

export type StaffNavGroup = {
  id: string;
  label: string;
  /**
   * True for the one group that is folded away behind a disclosure.
   *
   * The sidebar renders these items only once the reader asks for them. It is
   * the difference between "this tool exists" and "this tool is part of your
   * day", and it is the whole reason the primary list is readable at a glance.
   */
  secondary?: boolean;
  /** A group whose items are all hidden is not rendered; see `visibleStaffNav`. */
  items: readonly StaffNavItem[];
};

export const STAFF_NAV: readonly StaffNavGroup[] = [
  /**
   * The four things a shop does, one per group, in the order work travels:
   * decide what is happening, take the order, make it, send it.
   *
   * Each is a single row rather than a heading over a list, because each *is*
   * one destination. Orders was previously grouped with Production and
   * Fulfillment, which invited the reader to wonder which of the three an order
   * is actually managed from — the answer is Orders, and the layout now says so.
   */
  {
    id: "dashboard",
    label: "Dashboard",
    items: [
      {
        href: "/staff",
        label: "Dashboard",
        description: "What needs attention right now, across the whole shop.",
        icon: "dashboard",
      },
    ],
  },
  {
    id: "orders",
    label: "Orders",
    items: [
      {
        href: "/staff/orders",
        label: "Orders",
        description: "Every order, and where each one is. Open an order to manage all of it.",
        icon: "orders",
        anyOf: ["orders.view", "orders.manage"],
      },
    ],
  },
  /**
   * **Support** — primary, and beside Orders rather than under "More tools".
   *
   * It earns that place on the same test every other primary row passes: it is
   * opened every day, and something in it is waiting on a person. The surface it
   * replaces (`/contact`, which emailed a mailbox and stored nothing) had no
   * staff entry at all, which is precisely why nobody could say how many
   * questions were outstanding.
   */
  {
    id: "support",
    label: "Support",
    items: [
      {
        href: "/staff/support",
        label: "Support",
        description: "Customer conversations: what they asked, who owns it, and what is still open.",
        icon: "users",
        anyOf: ["support.view"],
      },
    ],
  },
  {
    id: "production",
    label: "Production",
    items: [
      {
        href: "/staff/production",
        label: "Production",
        description: "The workshop queue: what has to be made, in what order, and by when.",
        icon: "production",
        anyOf: ["production.view", "production.manage"],
      },
    ],
  },
  {
    id: "fulfillment",
    label: "Fulfillment",
    items: [
      {
        href: "/staff/fulfillment",
        // A queue, not a second order editor. The description says so, because
        // "Fulfillment" beside "Orders" is otherwise a fair invitation to
        // wonder which of the two an order is managed from.
        label: "Fulfillment",
        description: "A queue of what is ready to pack, collect or ship. Editing happens on the order.",
        icon: "truck",
        anyOf: ["fulfillment.view", "fulfillment.manage"],
      },
    ],
  },
  /**
   * **Store** — everything about what customers can buy.
   *
   * Inventory lives here rather than beside Production. It was moved out to
   * "Operations" last pass on the theory that correcting a count is operational
   * work; in practice a staff member goes to Inventory *from* a product, and
   * splitting the four store surfaces across two groups meant the answer to
   * "where do I manage the shop" was two places.
   */
  {
    id: "store",
    label: "Store",
    items: [
      {
        href: "/staff/catalog",
        // The route still says "catalog"; the menu does not. Route history is
        // not something a staff member should have to learn.
        label: "Products",
        description: "Product details, media, pricing, options, shipping and stock rules.",
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
        href: "/staff/inventory",
        label: "Inventory",
        description: "On hand, reserved and available stock, with every movement.",
        icon: "inventory",
        anyOf: ["inventory.view", "inventory.manage"],
      },
      {
        href: "/staff/catalog/discounts",
        label: "Discounts",
        description: "Codes, targeting, limits and the redemption report.",
        icon: "discount",
        anyOf: ["catalog.discounts.manage"],
      },
    ],
  },
  /**
   * **Business** — consulted rather than worked through.
   *
   * You come here to answer a question or because something is wrong. Keeping
   * it below the daily path is the point: Reconciliation and Launch readiness
   * once sat beside Orders, giving a page somebody opens twice a month the same
   * weight as the page they live in.
   */
  {
    id: "business",
    label: "Business",
    items: [
      {
        href: "/staff/emails",
        label: "Email",
        description: "The templates customers receive, delivery history and sender settings.",
        icon: "email",
        // The delivery log is a tab of this page now, not a route of its own.
        alsoOwns: ["/staff/emails/deliveries"],
        /*
         * Listed on the settings index as well as in Business.
         *
         * Sender identity, the master switch and the wording of every
         * transactional message are configuration by any reading — set once and
         * then left alone — and `/staff/settings` was the one place a person
         * looking for "where do I change what our emails say" would go, and the
         * one place it was not. `settingsSection` exists exactly so a tool can
         * be listed there without moving in the sidebar, which is why the
         * Business group below is unchanged.
         */
        settingsSection: "store",
        anyOf: ["emails.manage", "emails.view", "emails.resend"],
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
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        href: "/staff/settings/commerce",
        label: "Commerce",
        description: "Checkout, delivery, pickup, stock rules, returns and cancellation policy.",
        icon: "commerce",
        settingsSection: "store",
        anyOf: ["commerce.settings.view", "commerce.settings.manage"],
      },
      {
        href: "/staff/appearance",
        label: "Appearance",
        description: "Colors, logos, wording and control styles for the storefront and the staff area.",
        icon: "appearance",
        settingsSection: "design",
        anyOf: ["appearance.manage"],
      },
      {
        href: "/staff/security/roles",
        label: "Roles & permissions",
        description: "Which staff roles can view and manage each area.",
        icon: "roles",
        settingsSection: "access",
        anyOf: ["roles.view"],
      },
      {
        href: "/staff/settings",
        label: "All settings",
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
          "users.view",
        ],
      },
    ],
  },
  /**
   * **More tools** — real, supported, and not part of a normal day.
   *
   * Folded away rather than deleted. Everything here was a top-level row before
   * this pass; none of it is opened daily, and all of it stayed in the menu at
   * full weight because no pass had been willing to say so. Each item is still
   * one click from the sidebar once the disclosure is open, and the ones that
   * are genuinely configuration also appear on `/staff/settings`.
   *
   * `/staff/community` is deliberately still absent: community is dormant on
   * the customer side, and a staff entry for a section customers cannot reach
   * would be an invitation to curate something nobody will read. The route and
   * its permissions are untouched.
   */
  {
    id: "more",
    label: "More tools",
    secondary: true,
    items: [
      {
        href: "/staff/materials",
        label: "Materials",
        description: "Raw material stock, unit costs, suppliers, and reorder signals.",
        icon: "inventory",
        anyOf: ["materials.view", "materials.manage"],
      },
      {
        href: "/staff/suppliers",
        label: "Suppliers",
        description: "Supplier contacts, purchasing details, and associated materials.",
        icon: "shops",
        anyOf: ["suppliers.view", "suppliers.manage"],
      },
      {
        href: "/staff/finance",
        label: "Finance",
        description: "Revenue, estimated COGS, margins, expenses, and operating profit.",
        icon: "analytics",
        anyOf: ["finance.view", "finance.manage"],
        alsoOwns: ["/staff/expenses"],
      },
      /*
       * Automation is secondary in the sidebar and a first-class row under
       * Settings, which is what `settingsSection` exists for.
       *
       * It could have gone in the Settings group beside Commerce, and that would
       * have made it the eighteenth always-visible destination. The ceiling
       * assertion in `tests/staff-navigation.test.ts` asks whoever raises it to
       * argue the case, and the case is not there: Support earned its slot by
       * being a queue with people waiting in it, worked every day. Reminder
       * thresholds are set once and then left alone for months. A page nobody
       * opens twice a month does not deserve the same weight as Orders.
       *
       * The failures it surfaces do not depend on anybody finding this row —
       * `ops.automation_failure` goes to the bell, and its deep link lands here.
       */
      {
        href: "/staff/settings/automation",
        label: "Automation",
        description: "Scheduled reminders, when they go out, and whether the scheduler is running.",
        icon: "settings",
        settingsSection: "store",
        anyOf: ["automation.view", "automation.manage"],
      },
      {
        href: "/staff/analytics",
        label: "Analytics",
        description: "Revenue, orders and site metrics over time.",
        icon: "analytics",
        anyOf: ["analytics.view"],
      },
      {
        // `/staff/security/users` redirects here. The nav points at the real
        // page so the browser does not take a redirect on every visit.
        href: "/staff/users",
        // One word, and the same word the page's own title uses. "People &
        // accounts" was the menu row, the page heading, and half of two buttons
        // ("All people", "Back to people") that went to the same place.
        label: "People",
        // The name promised orders and history and now delivers them: the
        // workspace behind this link carries a customer's orders, spend,
        // production, support, email and audit trail beside their access.
        description: "Customers and staff: orders, spend, support, access, notes and account status.",
        icon: "users",
        alsoOwns: ["/staff/info/users", "/staff/security/users"],
        settingsSection: "access",
        anyOf: ["users.view"],
      },
      {
        href: "/staff/moderation/reports",
        label: "Reports",
        description: "The report queue, escalations and moderation decisions.",
        icon: "moderation",
        alsoOwns: ["/staff/moderation"],
        anyOf: ["moderation.reports.view"],
      },
      {
        href: "/staff/security",
        label: "Site access & safety",
        description: "Maintenance mode, lockdown, IP restrictions and emergency messaging.",
        icon: "security",
        settingsSection: "access",
        anyOf: ["security.view"],
      },
      {
        href: "/staff/security/verified-perks",
        label: "Verified perks",
        description: "Bonus permissions granted to verified members.",
        icon: "perks",
        settingsSection: "access",
        anyOf: ["security.verified_perks.manage"],
      },
      {
        // `/staff/security/audit` redirects here. The nav points at the real
        // page so the browser does not take a redirect on every visit.
        href: "/staff/audit",
        label: "Audit log",
        description: "Who changed what, and what it was before.",
        icon: "audit",
        settingsSection: "system",
        anyOf: ["audit.view", "audit.read"],
      },
      {
        href: "/staff/security/recycle-bin",
        label: "Recycle bin",
        description: "Soft-deleted content awaiting expiry, and restores.",
        icon: "recycle",
        settingsSection: "system",
        anyOf: ["recycle_bin.view"],
      },
      {
        href: "/staff/info/todo",
        label: "To-do board",
        description: "Shared staff tasks and who is carrying them.",
        icon: "todo",
        anyOf: ["todo.view"],
      },
      {
        href: "/staff/info/pending",
        label: "Pending submissions",
        description: "Member-submitted pages waiting for review.",
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
      {
        href: "/staff/shops",
        label: "Shops",
        description: "Partner shops and their published listings.",
        icon: "shops",
        anyOf: ["shops.view"],
      },
    ],
  },
];

/** Every item, flattened. Order is the order it is displayed in. */
export const STAFF_NAV_ITEMS: readonly StaffNavItem[] = STAFF_NAV.flatMap((group) => group.items);

/**
 * The destinations that are visible without opening a disclosure.
 *
 * Exported so a test can hold the line: this pass took the sidebar from 27 to
 * 16, and the failure mode for the next pass is adding "just one more" row
 * until it is 27 again.
 */
export const PRIMARY_STAFF_NAV_ITEMS: readonly StaffNavItem[] = STAFF_NAV.filter(
  (group) => !group.secondary
).flatMap((group) => group.items);

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

/** The always-visible part of the menu for this viewer. */
export function primaryStaffNav(permissions: ReadonlySet<string>): StaffNavGroup[] {
  return visibleStaffNav(permissions).filter((group) => !group.secondary);
}

/**
 * The settings index, as named blocks.
 *
 * Reads `settingsSection` across the **whole** navigation rather than only the
 * Settings group, so folding a tool into "More tools" in the sidebar does not
 * quietly drop it off the settings directory. `/staff/settings` itself is
 * excluded — a settings index listing itself is a loop.
 */
export function staffSettingsSections(
  permissions: ReadonlySet<string>
): { id: StaffSettingsSection; label: string; description: string; items: StaffNavItem[] }[] {
  const items = visibleStaffNav(permissions)
    .flatMap((group) => group.items)
    .filter((item) => item.href !== "/staff/settings" && item.settingsSection);
  return STAFF_SETTINGS_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((item) => item.settingsSection === section.id),
  })).filter((section) => section.items.length > 0);
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
 * It is what makes `/staff/catalog/discounts` highlight Discounts rather than
 * Products, `/staff/settings/commerce` highlight itself rather than All
 * settings, and `/staff` highlight only the dashboard instead of every row.
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
  "/staff/launch-readiness/discrepancies": "Payment discrepancies",
};

const LEAF_PATTERNS: readonly { test: RegExp; label: string }[] = [
  { test: /^\/staff\/support\/[^/]+$/, label: "Conversation" },
  // "Person" rather than their name, for the reason stated above: the crumb
  // renders before the record loads, and a trail that changes from "Person" to
  // "Ethan Example" after a beat moves the page under the reader.
  { test: /^\/staff\/users\/[^/]+$/, label: "Person" },
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
 * destinations — linking one to the first page inside it sends a reader
 * somewhere they did not ask to go. A group whose label repeats its only item's
 * label ("Orders" → "Orders") contributes no crumb at all, which is what the
 * one-item primary groups introduced this pass would otherwise produce.
 */
export function staffBreadcrumbs(pathname: string): StaffCrumb[] {
  const match = activeStaffNavItem(pathname);
  if (!match) return [{ href: "/staff", label: "Staff", current: pathname === "/staff" }];

  const crumbs: StaffCrumb[] = [{ href: "/staff", label: "Staff", current: false }];
  if (match.item.href === "/staff") {
    crumbs[0].current = true;
    return crumbs;
  }

  if (match.group.label !== match.item.label) {
    crumbs.push({ href: "", label: match.group.label, current: false });
  }

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
