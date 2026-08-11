/**
 * What a person can actually do, said in words rather than in keys.
 *
 * The Access tab used to render 115 checkboxes in one ungrouped column labelled
 * `catalog.categories.manage`, with nothing on screen saying which of them the
 * person's role already granted. That screen could not answer the only question
 * a reader brings to it — *what can this person do?* — because it showed the
 * override table and called it the answer.
 *
 * This module decides three things, purely, so the page renders a decision
 * rather than making one:
 *
 *  1. **Which group a permission belongs to.** One home each, asserted total and
 *     disjoint by a test, so a permission added next year cannot silently land
 *     nowhere and disappear from the screen.
 *  2. **Where a permission comes from** for a given person — their role, an
 *     override on top of it, or nowhere.
 *  3. **What a role change would cost**, as group names rather than keys.
 *
 * No React, no `next/*`, no Supabase: the page, the tests and any future server
 * summary read the same functions.
 *
 * ## Overrides can only add
 *
 * `user_permissions` is an additive table. There is no deny row, and this
 * codebase has never had one. The UI therefore must not draw a three-state
 * control that implies a permission can be taken away from a role here — it
 * cannot, and the honest instruction is to change the role instead. That
 * sentence lives in {@link OVERRIDE_RULE} so the screen and the tests quote the
 * same one.
 */

import { PERMISSIONS, PERMISSION_META, type PermissionKey } from "../permissions.ts";

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type PermissionGroupId =
  | "commerce"
  | "production"
  | "support"
  | "communications"
  | "people"
  | "access"
  | "audit"
  | "automation"
  | "settings"
  | "community"
  | "business"
  | "system";

export type PermissionGroup = {
  id: PermissionGroupId;
  label: string;
  /** One line, in the words a staff member would use for the area itself. */
  description: string;
};

/**
 * The groups, in the order they are shown.
 *
 * Ordered by how often somebody opens this tab because of them: what the shop
 * sells and makes first, who can reach it next, and the housekeeping last.
 */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { id: "commerce", label: "Commerce", description: "Products, orders, stock, refunds and returns." },
  { id: "production", label: "Production", description: "The workshop queue and the jobs in it." },
  { id: "support", label: "Support", description: "Customer conversations, replies and assignment." },
  { id: "communications", label: "Communications", description: "Transactional email: wording, history and re-sending." },
  { id: "people", label: "People", description: "Customer and staff records, notes, and account standing." },
  { id: "access", label: "Access & security", description: "Roles, permissions and site safety controls." },
  { id: "audit", label: "Audit", description: "The record of who changed what." },
  { id: "automation", label: "Automation", description: "Scheduled reminders and the scheduler itself." },
  { id: "settings", label: "Settings", description: "Checkout rules, appearance and shop configuration." },
  { id: "community", label: "Community & content", description: "Forum, information pages and partner shops." },
  { id: "business", label: "Business", description: "Analytics, health and launch readiness." },
  {
    id: "system",
    label: "System",
    description: "The recycle bin, the shared to-do board and site-wide messaging.",
  },
];

/**
 * Prefix rules, longest match wins.
 *
 * Prefixes rather than the `PERMISSION_META` category because the categories
 * were written for a different screen and put `production.manage`,
 * `refunds.issue` and `emails.resend` in one bucket called "Commerce". Grouping
 * by what a person would go looking for beats grouping by the table the key was
 * declared next to.
 */
const PREFIX_GROUPS: readonly (readonly [string, PermissionGroupId])[] = [
  ["catalog.", "commerce"],
  ["orders.", "commerce"],
  ["inventory.", "commerce"],
  ["fulfillment.", "commerce"],
  ["refunds.", "commerce"],
  ["returns.", "commerce"],
  ["cancellations.", "commerce"],
  ["payments.", "commerce"],

  ["production.", "production"],

  ["support.", "support"],

  ["emails.", "communications"],
  ["notifications.", "system"],

  ["users.", "people"],
  // Bans, restrictions and timeouts are the account-standing powers the status
  // panel spends. They act on a person, so they are filed with people rather
  // than with forum moderation, which is `moderation.reports.*` below.
  ["moderation.ban", "people"],
  ["moderation.restrict", "people"],
  ["moderation.timeout", "people"],
  ["moderation.reports.", "community"],

  ["roles.", "access"],
  ["permissions.", "access"],
  ["security.settings.", "settings"],
  ["security.", "access"],

  ["audit.", "audit"],
  ["automation.", "automation"],

  ["commerce.settings.", "settings"],
  ["appearance.", "settings"],
  ["community.categories.", "settings"],

  ["community.", "community"],
  ["info.", "community"],
  ["shops.", "community"],

  ["analytics.", "business"],
  ["operations.", "business"],
  ["launch.", "business"],

  ["recycle_bin.", "system"],
  // The shared staff to-do board. Not community content — nobody outside the
  // staff area can see it — and not a security control either.
  ["todo.", "system"],
];

const GROUP_BY_KEY: Readonly<Record<string, PermissionGroupId>> = (() => {
  const map: Record<string, PermissionGroupId> = {};
  for (const key of PERMISSIONS) {
    let best: { length: number; group: PermissionGroupId } | null = null;
    for (const [prefix, group] of PREFIX_GROUPS) {
      if (!key.startsWith(prefix)) continue;
      if (!best || prefix.length > best.length) best = { length: prefix.length, group };
    }
    // No fallback bucket on purpose. A key with no rule must fail the totality
    // test rather than land in "Other", which is where things go to be missed.
    if (best) map[key] = best.group;
  }
  return map;
})();

/** The group a permission belongs to, or `null` when no rule claims it. */
export function permissionGroup(key: string): PermissionGroupId | null {
  return GROUP_BY_KEY[key] ?? null;
}

/** Every permission this group owns, in declaration order. */
export function permissionsInGroup(group: PermissionGroupId): PermissionKey[] {
  return (PERMISSIONS as readonly PermissionKey[]).filter((key) => GROUP_BY_KEY[key] === group);
}

/**
 * The label a permission is shown under.
 *
 * `PERMISSION_META.label` already reads as a sentence ("Manage products"), which
 * is what belongs on screen. The raw key is still available — see
 * {@link permissionRow} — because somebody debugging a grant needs it, but it
 * lives behind Advanced rather than being the only thing offered.
 */
export function permissionLabel(key: string): string {
  return PERMISSION_META[key as PermissionKey]?.label ?? key;
}

export function permissionDescription(key: string): string | null {
  return PERMISSION_META[key as PermissionKey]?.description ?? null;
}

// ---------------------------------------------------------------------------
// Where a permission comes from
// ---------------------------------------------------------------------------

/**
 * `role` — the role grants it. `override` — granted to this person on top of the
 * role. `none` — not held.
 *
 * There is deliberately no `denied`. See {@link OVERRIDE_RULE}.
 */
export const PERMISSION_SOURCES = ["role", "override", "none"] as const;
export type PermissionSource = (typeof PERMISSION_SOURCES)[number];

export const PERMISSION_SOURCE_LABELS: Readonly<Record<PermissionSource, string>> = {
  role: "From role",
  override: "Added for this person",
  none: "Not granted",
};

/**
 * The mark beside each row, chosen so the three states differ by **shape**
 * rather than only by colour.
 */
export const PERMISSION_SOURCE_MARKS: Readonly<Record<PermissionSource, string>> = {
  role: "✓",
  override: "+",
  none: "○",
};

export const OVERRIDE_RULE =
  "Overrides can only add. Unticking something the role grants does not take it away — change the role instead.";

export type PermissionRow = {
  key: PermissionKey;
  label: string;
  description: string | null;
  source: PermissionSource;
  /** True when the role grants it, whatever the override says. */
  fromRole: boolean;
  /** True when this person carries an explicit grant row. */
  overridden: boolean;
};

export function permissionRow(input: {
  key: PermissionKey;
  rolePermissions: ReadonlySet<string>;
  overrides: ReadonlySet<string>;
}): PermissionRow {
  const fromRole = input.rolePermissions.has(input.key);
  const overridden = input.overrides.has(input.key);
  return {
    key: input.key,
    label: permissionLabel(input.key),
    description: permissionDescription(input.key),
    // The role wins the label when both are true: an override that duplicates
    // the role is not an exception, and calling it one invites somebody to
    // "clean it up" by removing a grant they think is doing something.
    source: fromRole ? "role" : overridden ? "override" : "none",
    fromRole,
    overridden,
  };
}

export type PermissionGroupView = PermissionGroup & {
  rows: PermissionRow[];
  /** How many of this group's permissions the person actually holds. */
  heldCount: number;
  /** How many come from an override rather than the role. */
  overrideCount: number;
};

/** Every group, with its rows resolved for one person. */
export function permissionGroupViews(input: {
  rolePermissions: ReadonlySet<string>;
  overrides: ReadonlySet<string>;
}): PermissionGroupView[] {
  return PERMISSION_GROUPS.map((group) => {
    const rows = permissionsInGroup(group.id).map((key) =>
      permissionRow({ key, rolePermissions: input.rolePermissions, overrides: input.overrides })
    );
    return {
      ...group,
      rows,
      heldCount: rows.filter((row) => row.source !== "none").length,
      overrideCount: rows.filter((row) => row.source === "override").length,
    };
  }).filter((group) => group.rows.length > 0);
}

/** Everything the person holds, role and overrides together. */
export function effectivePermissions(input: {
  rolePermissions: ReadonlySet<string>;
  overrides: ReadonlySet<string>;
}): Set<string> {
  return new Set([...input.rolePermissions, ...input.overrides]);
}

// ---------------------------------------------------------------------------
// What a role change costs
// ---------------------------------------------------------------------------

export type RoleChangeImpact = {
  /** Group labels the person would stop being able to reach. */
  lost: string[];
  /** Group labels they would gain. */
  gained: string[];
  /** Group labels they keep, so the screen can say what is *not* changing. */
  retained: string[];
  /** Individual permissions lost, for the Advanced disclosure. */
  lostKeys: string[];
  gainedKeys: string[];
};

/**
 * The difference between two roles, expressed as areas.
 *
 * Areas rather than keys because "this removes `catalog.categories.manage`" is
 * not a sentence anybody can act on, whereas "this removes Commerce" is. A group
 * counts as lost only when the person ends up holding **nothing** in it: losing
 * one of nine commerce permissions is not losing commerce, and saying so would
 * make the warning noise.
 *
 * Overrides are included on both sides because they survive a role change — the
 * grant rows are not touched by it — so a person keeping an area only through an
 * override must not be told they are losing it.
 */
export function roleChangeImpact(input: {
  currentRolePermissions: ReadonlySet<string>;
  nextRolePermissions: ReadonlySet<string>;
  overrides: ReadonlySet<string>;
}): RoleChangeImpact {
  const before = effectivePermissions({
    rolePermissions: input.currentRolePermissions,
    overrides: input.overrides,
  });
  const after = effectivePermissions({
    rolePermissions: input.nextRolePermissions,
    overrides: input.overrides,
  });

  const lost: string[] = [];
  const gained: string[] = [];
  const retained: string[] = [];

  for (const group of PERMISSION_GROUPS) {
    const keys = permissionsInGroup(group.id);
    if (!keys.length) continue;
    const heldBefore = keys.some((key) => before.has(key));
    const heldAfter = keys.some((key) => after.has(key));
    if (heldBefore && !heldAfter) lost.push(group.label);
    else if (!heldBefore && heldAfter) gained.push(group.label);
    else if (heldBefore && heldAfter) retained.push(group.label);
  }

  return {
    lost,
    gained,
    retained,
    lostKeys: [...before].filter((key) => !after.has(key)).sort(),
    gainedKeys: [...after].filter((key) => !before.has(key)).sort(),
  };
}
