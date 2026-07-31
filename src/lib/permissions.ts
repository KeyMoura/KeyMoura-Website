import { normalizeRole } from "./roles.ts";

/**
 * All permission keys supported by the application.
 */
export const PERMISSIONS = [
  "analytics.view",
  "community.view",
  "security.view",
  "audit.view",
  "shops.view",
  "catalog.view",
  "catalog.manage",
  "orders.view",
  "orders.manage",
  "appearance.manage",
  "emails.manage",
  // Reports
  "moderation.reports.view",
  "moderation.reports.moderate",
  "moderation.reports.override",
  "moderation.ban",
  "moderation.ban.request",

  // Moderation
  "moderation.restrict",
  "moderation.restrict.request",
  "moderation.timeout",
  "moderation.timeout.request",
  "moderation.timeout.community",
  "moderation.timeout.community.request",
  "moderation.timeout.dm",
  "moderation.timeout.dm.request",


  "moderation.restrict.community",
  "moderation.restrict.community.request",
  "moderation.restrict.dm",
  "moderation.restrict.dm.request",
  "community.create_thread",
  "community.lock_thread",
  "community.thread.lock.own",
  "community.pin_thread",
  "community.delete_post",
  "community.post.edit",
  "community.post.edit.own",
  "community.post.delete.own",
  "community.restore_post",
  "community.mark_answer",
  "community.thread.mark_answer.own",
  "community.flags.set.1",
  "community.flags.set.3",
  "community.flags.set.5",
  "community.flags.set.10",
  "community.categories.manage",
  "community.categories.edit",
  "community.delete_thread",
  "community.thread.delete.own",
  "community.blocks.bypass",
  "notifications.broadcast",
  "info.submit",
  "info.update.submit",
  "info.moderate",
  "info.pending.view",
  "info.updates.view",
  // To-do
  "todo.view",
  "todo.create_task",
  "todo.mark_done",
  "todo.edit",
  // Shops
  "shops.moderate",
  "shops.create",
  "shops.modify",
  "shops.delete",
  "shops.publish",
  "shops.reorder",
  "audit.read",
  "users.dm",
  "users.view",
  "recycle_bin.view",
  "recycle_bin.restore",
  "roles.view",
  "security.verified_perks.manage",
  "recycle_bin.read",
  "roles.manage",
  "permissions.manage",
  "roles.assign",
  "permissions.grant",
  "users.search",
  "users.verify",
  "users.donation_rank.set",
  "users.profile.edit",
  "security.approvals.manage",
  "security.approvals.override",
  "users.create",
  "security.force_logout",
  "security.settings.manage",
  "security.broadcast",
  "security.ip_logs.view",
] as const;

/**
 * A string-literal union of all permissions.
 */
export type PermissionKey = (typeof PERMISSIONS)[number];

/**
 * Human-facing metadata for permission keys.
 *
 * This is the canonical source used by staff UI to display what each permission does.
 */
export const PERMISSION_META: Readonly<Record<PermissionKey, { category: string; label: string; description: string }>> =
  {
    "analytics.view": {
      category: "Analytics",
      label: "View analytics",
      description: "Allows viewing staff analytics dashboards and site metrics.",
    },

    "community.view": {
      category: "Community",
      label: "View staff community tools",
      description: "Allows viewing the staff community moderation section.",
    },

    "catalog.view": {
      category: "Commerce",
      label: "View catalog tools",
      description: "Allows viewing the staff product catalog.",
    },
    "catalog.manage": {
      category: "Commerce",
      label: "Manage catalog",
      description: "Allows creating, editing, publishing, and archiving KeyMoura products.",
    },
    "orders.view": {
      category: "Commerce",
      label: "View orders",
      description: "Allows viewing customer requests and orders.",
    },
    "orders.manage": {
      category: "Commerce",
      label: "Manage orders",
      description: "Allows accepting requests and updating order, payment, and customer-visible details.",
    },
    "appearance.manage": {
      category: "Site",
      label: "Manage appearance",
      description: "Allows changing the shared KeyMoura colors, typography, spacing, and control styles.",
    },
    "emails.manage": {
      category: "Commerce",
      label: "Manage email",
      description: "Allows configuring transactional email, editing templates, and reviewing delivery history.",
    },

    "security.view": {
      category: "Security",
      label: "View security tools",
      description: "Allows viewing the staff security section (users, roles, permissions, recycle bin).",
    },

    "security.ip_logs.view": {
      category: "Security",
      label: "View IP logs",
      description: "Allows viewing login/IP history and last-known IP information in staff tools.",
    },
    "audit.view": {
      category: "Audit",
      label: "View audit log",
      description: "Allows viewing the staff audit log.",
    },
    "shops.view": {
      category: "Shops",
      label: "View shops tools",
      description: "Allows viewing the staff shops moderation section.",
    },

    "moderation.reports.view": {
      category: "Reports",
      label: "View reports",
      description: "Allows viewing the reports queue and report details.",
    },
    "moderation.reports.moderate": {
      category: "Reports",
      label: "Moderate reports",
      description: "Allows taking actions from reports (resolve, dismiss, escalate, assign).",
    },
    "moderation.reports.override": {
      category: "Reports",
      label: "Override reports",
      description: "Allows admin-level overrides on reports (de-escalate, force actions, visibility of escalated queue).",
    },
    "moderation.ban": {
      category: "Moderation",
      label: "Ban/unban users",
      description: "Allows staff to ban or unban users directly.",
    },
    "moderation.ban.request": {
      category: "Moderation",
      label: "Request bans",
      description: "Allows staff to submit a ban request instead of directly banning.",
    },

    // Moderation & restrictions
    "moderation.restrict": {
      category: "Moderation",
      label: "Site restrictions",
      description: "Allows applying or clearing site-wide restrictions (temporary restriction / tempban).",
    },
    "moderation.restrict.request": {
      category: "Moderation",
      label: "Request site restrictions",
      description: "Allows requesting site restriction changes for approval when you cannot apply them directly.",
    },
    "moderation.timeout": {
      category: "Moderation",
      label: "Timeout users",
      description: "Allows applying or clearing timeouts (temporary site restriction).",
    },
    "moderation.timeout.request": {
      category: "Moderation",
      label: "Request timeouts",
      description: "Allows requesting timeouts for approval when you cannot apply them directly.",
    },
    "moderation.timeout.community": {
      category: "Moderation",
      label: "Community timeouts",
      description: "Allows applying or clearing community-only timeouts.",
    },
    "moderation.timeout.community.request": {
      category: "Moderation",
      label: "Request community timeouts",
      description: "Allows requesting community timeouts for approval when you cannot apply them directly.",
    },
    "moderation.timeout.dm": {
      category: "Moderation",
      label: "DM timeouts",
      description: "Allows applying or clearing DM-only timeouts.",
    },
    "moderation.timeout.dm.request": {
      category: "Moderation",
      label: "Request DM timeouts",
      description: "Allows requesting DM timeouts for approval when you cannot apply them directly.",
    },

    "moderation.restrict.community": {
      category: "Moderation",
      label: "Community restrictions",
      description: "Allows applying or clearing community posting restrictions.",
    },
    "moderation.restrict.community.request": {
      category: "Moderation",
      label: "Request community restrictions",
      description: "Allows requesting community restriction changes for approval when you cannot apply them directly.",
    },
    "moderation.restrict.dm": {
      category: "Moderation",
      label: "DM restrictions",
      description: "Allows applying or clearing direct message restrictions.",
    },
    "moderation.restrict.dm.request": {
      category: "Moderation",
      label: "Request DM restrictions",
      description: "Allows requesting DM restriction changes for approval when you cannot apply them directly.",
    },
    "users.dm": {
      category: "Users",
      label: "DM users",
      description: "Allows opening/starting a DM thread with a user from staff tools.",
    },
    "community.create_thread": {
      category: "Community",
      label: "Create threads",
      description: "Allows creating new community threads.",
    },
    "community.lock_thread": {
      category: "Community",
      label: "Lock threads",
      description: "Allows locking/unlocking threads.",
    },
    "community.thread.lock.own": {
      category: "Community",
      label: "Lock own threads",
      description: "Allows locking/unlocking threads you created.",
    },
    "community.pin_thread": {
      category: "Community",
      label: "Pin threads",
      description: "Allows pinning/unpinning threads.",
    },
    "community.delete_post": {
      category: "Community",
      label: "Delete posts",
      description: "Allows soft-deleting community posts.",
    },
    "community.post.edit": {
      category: "Community",
      label: "Edit posts",
      description: "Allows editing community posts.",
    },
    "community.post.edit.own": {
      category: "Community",
      label: "Edit own posts",
      description: "Allows users to edit their own posts and replies.",
    },

    "community.post.delete.own": {
      category: "Community",
      label: "Delete own posts",
      description: "Allows users to delete their own posts and replies.",
    },
    "community.restore_post": {
      category: "Community",
      label: "Restore posts",
      description: "Allows restoring soft-deleted community posts.",
    },
    "community.mark_answer": {
      category: "Community",
      label: "Mark answers",
      description: "Allows marking a reply as the accepted answer.",
    },
    "community.thread.mark_answer.own": {
      category: "Community",
      label: "Mark answers in own threads",
      description: "Allows marking accepted answers in threads you created.",
    },
    "community.flags.set.1": {
      category: "Community",
      label: "Set flags per thread (1)",
      description: "Allows setting up to 1 flag per thread.",
    },
    "community.flags.set.3": {
      category: "Community",
      label: "Set flags per thread (3)",
      description: "Allows setting up to 3 flags per thread.",
    },
    "community.flags.set.5": {
      category: "Community",
      label: "Set flags per thread (5)",
      description: "Allows setting up to 5 flags per thread.",
    },
    "community.flags.set.10": {
      category: "Community",
      label: "Set flags per thread (10)",
      description: "Allows setting up to 10 flags per thread.",
    },
    "info.submit": {
      category: "Info",
      label: "Submit info",
      description: "Allows submitting new info pages or edits for review.",
    },
    "info.update.submit": {
      category: "Info",
      label: "Submit info updates",
      description: "Allows submitting updates to existing info pages for review.",
    },
    "info.moderate": {
      category: "Info",
      label: "Moderate info",
      description: "Allows reviewing and publishing info submissions.",
    },
    "info.pending.view": {
      category: "Info",
      label: "View pending info",
      description: "Allows viewing pending info submissions that require review.",
    },
    "info.updates.view": {
      category: "Info",
      label: "View pending updates",
      description: "Allows viewing proposed updates to existing info pages that require review.",
    },

    "todo.view": {
      category: "To-do",
      label: "View to-do board",
      description: "Allows viewing the staff to-do board.",
    },
    "todo.create_task": {
      category: "To-do",
      label: "Create tasks",
      description: "Allows creating new tasks on the staff to-do board.",
    },
    "todo.mark_done": {
      category: "To-do",
      label: "Mark tasks done",
      description: "Allows marking tasks as done (and reopening them).",
    },
    "todo.edit": {
      category: "To-do",
      label: "Edit tasks",
      description: "Allows editing task titles, descriptions, and notes.",
    },
    "shops.create": {
      category: "Shops",
      label: "Create shops",
      description: "Allows creating new shops.",
    },
    "shops.modify": {
      category: "Shops",
      label: "Modify shops",
      description: "Allows editing existing shops and their fields.",
    },
    "shops.delete": {
      category: "Shops",
      label: "Delete shops",
      description: "Allows deleting shops.",
    },
    "shops.publish": {
      category: "Shops",
      label: "Publish shops",
      description: "Allows toggling a shop's published status.",
    },
    "shops.reorder": {
      category: "Shops",
      label: "Reorder shops",
      description: "Allows changing shop ordering/priority.",
    },
    "shops.moderate": {
      category: "Shops",
      label: "Moderate shops",
      description: "Allows full control over shops (create/modify/delete/publish/reorder).",
    },
    "audit.read": {
      category: "Audit",
      label: "Read audit log",
      description: "Allows viewing audit events and staff action logs.",
    },
    "recycle_bin.read": {
      category: "Recycle Bin",
      label: "Read recycle bin",
      description: "Allows viewing the moderation recycle bin (soft-deleted items awaiting expiry).",
    },
    "roles.manage": {
      category: "Roles",
      label: "Manage roles",
      description: "Allows managing roles and role membership.",
    },
    "permissions.manage": {
      category: "Permissions",
      label: "Manage permission catalog",
      description: "Allows managing the permissions catalog and role permission assignments.",
    },
    "roles.assign": {
      category: "Roles",
      label: "Assign roles",
      description: "Allows assigning a role to a user.",
    },
    "permissions.grant": {
      category: "Permissions",
      label: "Grant direct permissions",
      description: "Allows granting direct permissions to a user.",
    },
    "users.search": {
      category: "Users",
      label: "Search users",
      description: "Allows searching and viewing user accounts in staff tools.",
    },

    "users.view": {
      category: "Users",
      label: "View Users tool",
      description: "Allows viewing the staff Users page.",
    },
    "recycle_bin.view": {
      category: "Recycle Bin",
      label: "View Recycle Bin",
      description: "Allows viewing the staff Recycle Bin page.",
    },
    "recycle_bin.restore": {
      category: "Recycle Bin",
      label: "Restore from Recycle Bin",
      description: "Allows restoring soft-deleted items from the recycle bin.",
    },
    "roles.view": {
      category: "Roles",
      label: "View Roles",
      description: "Allows viewing the staff Roles page.",
    },
    "security.verified_perks.manage": {
      category: "Security",
      label: "Manage verified perks",
      description: "Allows configuring bonus permissions granted to verified users.",
    },
    "users.verify": {
      category: "Users",
      label: "Verify users",
      description: "Allows setting verified/unverified status for a user.",
    },
    "users.donation_rank.set": {
      category: "Users",
      label: "Set donor rank",
      description: "Allows setting a user's donor rank.",
    },
    "users.profile.edit": {
      category: "Users",
      label: "Edit profiles",
      description: "Allows editing user profile fields (username, display name, bio, location, avatar).",
    },
    "community.categories.manage": {
      category: "Community",
      label: "Manage categories",
      description: "Allows creating, editing, and deleting community categories/tags.",
    },
    "community.categories.edit": {
      category: "Community",
      label: "Edit categories",
      description: "Allows editing existing community categories.",
    },

    "community.delete_thread": {
      category: "Community",
      label: "Delete threads",
      description: "Allows deleting community threads.",
    },

    "community.thread.delete.own": {
      category: "Community",
      label: "Delete own threads",
      description: "Allows users to delete their own threads.",
    },

    "community.blocks.bypass": {
      category: "Community",
      label: "Bypass block filters",
      description: "Allows viewing community content from users involved in blocks.",
    },

    "notifications.broadcast": {
      category: "Security",
      label: "Broadcast notifications",
      description: "Allows sending broadcast notifications to staff/users.",
    },

    "security.approvals.manage": {
      category: "Security",
      label: "Manage approval queue",
      description: "Allows viewing and approving/rejecting queued high-risk staff actions.",
    },

    "security.approvals.override": {
      category: "Security",
      label: "Override approvals",
      description: "Allows overriding approval safeguards (use sparingly).",
    },

    "users.create": {
      category: "Users",
      label: "Create users",
      description: "Allows creating new user accounts via staff tools.",
    },

    "security.force_logout": {
      category: "Security",
      label: "Force logout users",
      description: "Allows forcing users to log out of all sessions.",
    },

    "security.settings.manage": {
      category: "Security",
      label: "Manage security settings",
      description: "Allows editing security settings (limits, toggles, etc.).",
    },

    "security.broadcast": {
      category: "Security",
      label: "Broadcast security alerts",
      description: "Allows sending security broadcast messages/alerts.",
    },

  };

/**
 * A normalized actor access model used for authorization decisions.
 */
export type ActorAccess = {
  userId: string;
  role: string;
  permissions: ReadonlySet<PermissionKey>;
  /**
   * When true, the actor is an owner/operator account and is treated as having all permissions.
   * This flag is intended to be managed only in the database.
   */
  isOp?: boolean;
};

/**
 * Default role-to-permission mapping.
 *
 * This preserves the existing role behavior while migrating checks away from hardcoded role comparisons.
 */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly PermissionKey[]>> = {
  admin: PERMISSIONS,
  moderator: [
    "moderation.reports.view",
    "moderation.reports.moderate",
    "moderation.ban.request",
    "moderation.restrict",
    "moderation.timeout.community",
    "moderation.timeout.community.request",
    "moderation.timeout.dm",
    "moderation.timeout.dm.request",

    "moderation.restrict.community",
    "moderation.restrict.dm",
    "users.dm",
    "community.create_thread",
    "community.lock_thread",
    "community.thread.lock.own",
    "community.pin_thread",
    "community.delete_post",
    "community.post.edit",
    "community.post.edit.own",
    "community.restore_post",
    "community.mark_answer",
    "community.thread.mark_answer.own",
    "community.flags.set.5",
    "info.submit",
    "info.update.submit",
    "info.moderate",
    "shops.view",
    "shops.moderate",
    "audit.read",
    "recycle_bin.read",
    "users.profile.edit",
  ],
  support: [
    "community.create_thread",
    "community.thread.lock.own",
    "community.post.edit.own",
    "community.post.delete.own",
    "community.thread.mark_answer.own",
    "community.flags.set.3",
    "community.thread.delete.own",
  ],
  staff: [
    "community.create_thread",
    "community.thread.lock.own",
    "community.post.edit.own",
    "community.post.delete.own",
    "community.thread.mark_answer.own",
    "community.flags.set.3",
    "community.thread.delete.own",
  ],
  member: [
    "community.create_thread",
    "community.thread.lock.own",
    "community.post.edit.own",
    "community.post.delete.own",
    "community.thread.mark_answer.own",
    "community.flags.set.1",
    "community.thread.delete.own",
    "info.submit",
    "info.update.submit",
  ],
};

/**
 * Returns a stable permission set for the given role.
 */
export function permissionsForRole(role: unknown): ReadonlySet<PermissionKey> {
  const normalized = normalizeRole(role);
  const granted = ROLE_PERMISSIONS[normalized] ?? ROLE_PERMISSIONS.member;
  return new Set(granted ?? []);
}

/**
 * Returns true when the actor has the specified permission.
 */
export function hasPermission(actor: ActorAccess | null, permission: PermissionKey): boolean {
  if (!actor) return false;
  return actor.permissions.has(permission);
}
