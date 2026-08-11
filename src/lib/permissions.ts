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
  "catalog.categories.manage",
  "catalog.discounts.manage",
  "catalog.reviews.moderate",
  "orders.view",
  "orders.manage",
  "production.view",
  "production.manage",
  // Order lifecycle. Deciding a cancellation, deciding a return and moving
  // money are separated from `orders.manage` on purpose: a shop hand who
  // updates tracking should not thereby be able to refund a customer. None of
  // these is granted to any non-admin role by default.
  "fulfillment.view",
  "fulfillment.manage",
  "cancellations.review",
  "returns.review",
  "refunds.issue",
  "inventory.view",
  "inventory.manage",
  // Commerce settings, added in pass 8. Separate from `appearance.manage`
  // because these values decide what customers are charged for delivery and
  // where parcels are posted, which is not a branding decision. Reading is
  // split from writing so the shipping desk can consult the configured methods
  // without being able to reprice them.
  "commerce.settings.view",
  "commerce.settings.manage",
  "appearance.manage",
  "emails.manage",
  // Communications, added in pass 12. Reading delivery history and re-sending
  // a message to a customer are separated from `emails.manage`, which is the
  // permission that edits template wording. They are three different powers:
  // editing what future messages say, seeing who was written to, and causing a
  // real email to leave the building again. None is granted to any non-admin
  // role by default.
  "emails.view",
  "emails.resend",
  // Operational readiness. Read-only surfaces plus the two decisions they
  // offer — acknowledging a launch warning and recording a conclusion about a
  // historical payment discrepancy. Neither writes a financial value.
  "operations.health.view",
  "launch.readiness.view",
  "launch.readiness.acknowledge",
  "payments.discrepancy.review",
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
  // Internal staff notes on a user, added in this pass. Reading and writing are
  // separate powers: a note can record why a customer was refused a refund, so
  // seeing them is useful to anyone on the desk while adding one is a claim that
  // goes on the permanent record and cannot be edited afterwards.
  "users.notes.view",
  "users.notes.manage",
  // Customer support, added in this pass. Four powers, split by what each
  // actually does: reading a customer's correspondence, writing to that customer
  // in KeyMoura's name, deciding a conversation's state, and deciding whose job
  // it is. Only the second one puts words in front of a customer, which is why
  // it is not folded into `support.view`.
  "support.view",
  "support.reply",
  "support.manage",
  "support.assign",
  // Scheduled automation, added in this pass. Two powers, and the split is the
  // usual one: reading what the scheduler is doing is useful to anyone on a desk
  // wondering why a reminder did or did not go out, while changing a threshold
  // decides what lands in a customer's inbox and when. Neither is granted to any
  // non-admin role by default.
  "automation.view",
  "automation.manage",
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
    "catalog.categories.manage": {
      category: "Commerce",
      label: "Manage product categories",
      description: "Allows creating, editing, reordering, and archiving catalog categories.",
    },
    "catalog.discounts.manage": {
      category: "Commerce",
      label: "Manage discount codes",
      description: "Allows creating, editing, targeting, and archiving discount codes.",
    },
    "catalog.reviews.moderate": {
      category: "Commerce",
      label: "Moderate product reviews",
      description: "Allows hiding, restoring, or removing product reviews and resolving reports.",
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
    "production.view": {
      category: "Commerce",
      label: "View production jobs",
      description: "Allows viewing the production queue, job details, and printable work orders.",
    },
    "production.manage": {
      category: "Commerce",
      label: "Manage production jobs",
      description:
        "Allows creating jobs, changing job status, editing checklists and files, and recording labour time.",
    },
    "fulfillment.view": {
      category: "Commerce",
      label: "View fulfillment",
      description: "Allows seeing shipping, pickup and tracking details on orders.",
    },
    "fulfillment.manage": {
      category: "Commerce",
      label: "Manage fulfillment",
      description:
        "Allows marking orders processing, ready for pickup, picked up, shipped or delivered, and editing tracking details.",
    },
    "cancellations.review": {
      category: "Commerce",
      label: "Review cancellations",
      description:
        "Allows approving or declining customer cancellation requests. Issuing the refund additionally needs Issue refunds.",
    },
    "returns.review": {
      category: "Commerce",
      label: "Review returns",
      description:
        "Allows approving or declining returns, recording receipt and inspection, and choosing whether stock is restored.",
    },
    "refunds.issue": {
      category: "Commerce",
      label: "Issue refunds",
      description:
        "Allows sending money back to a customer through Stripe. Grant this narrowly: it is the only permission that moves funds out.",
    },
    "inventory.view": {
      category: "Commerce",
      label: "View inventory",
      description: "Allows seeing stock levels and the history of every stock movement.",
    },
    "inventory.manage": {
      category: "Commerce",
      label: "Manage inventory",
      description: "Allows adjusting stock levels by hand, with a reason recorded against each change.",
    },
    "commerce.settings.view": {
      category: "Commerce",
      label: "View commerce settings",
      description: "Allows reading shipping methods, pickup details, inventory rules and commerce policy.",
    },
    "commerce.settings.manage": {
      category: "Commerce",
      label: "Manage commerce settings",
      description:
        "Allows changing shipping prices, destinations, pickup details, inventory rules and cancellation and return policy.",
    },
    "appearance.manage": {
      category: "Site",
      label: "Manage appearance",
      description: "Allows changing the shared KeyMoura colors, typography, spacing, and control styles.",
    },
    "emails.manage": {
      category: "Commerce",
      label: "Manage email",
      description: "Allows configuring transactional email and editing template wording.",
    },
    "emails.view": {
      category: "Commerce",
      label: "View email delivery history",
      description:
        "Allows seeing which transactional emails were sent, to a masked address, and whether they succeeded. Does not allow sending anything.",
    },
    "emails.resend": {
      category: "Commerce",
      label: "Re-send transactional email",
      description:
        "Allows re-sending a transactional email to its original recipient. The recipient and the wording are taken from the record and cannot be edited. Grant this narrowly: it causes a real email to leave the building.",
    },
    "operations.health.view": {
      category: "Operations",
      label: "View integration health",
      description:
        "Allows seeing whether the database, Stripe, Resend, analytics and authentication providers are configured and working. Shows no secret values.",
    },
    "launch.readiness.view": {
      category: "Operations",
      label: "View launch readiness",
      description: "Allows seeing the launch checklist and which items are blocking, warning or passed.",
    },
    "launch.readiness.acknowledge": {
      category: "Operations",
      label: "Acknowledge launch warnings",
      description:
        "Allows recording that a launch warning has been seen and accepted. Acknowledging changes no setting, order or financial value.",
    },
    "payments.discrepancy.review": {
      category: "Operations",
      label: "Review payment discrepancies",
      description:
        "Allows recording a conclusion about a historical order whose recorded total and payment rows disagree. Records the review only: it never creates a payment row or changes a total.",
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
    "users.notes.view": {
      category: "Security",
      label: "View staff notes on users",
      description:
        "Allows reading internal notes staff have recorded about a customer. Notes are never shown to the customer.",
    },
    "users.notes.manage": {
      category: "Security",
      label: "Write staff notes on users",
      description:
        "Allows adding and archiving internal notes about a customer. Notes cannot be edited or deleted once written, so this grants a permanent record.",
    },
    "support.view": {
      category: "Support",
      label: "View support",
      description:
        "Allows reading the support inbox, conversations and internal notes. Does not allow replying to a customer.",
    },
    "support.reply": {
      category: "Support",
      label: "Reply to customers",
      description:
        "Allows sending a customer-visible reply and adding internal notes. Grant this deliberately: a reply is a real email sent to a customer in KeyMoura's name and cannot be edited afterwards.",
    },
    "support.manage": {
      category: "Support",
      label: "Manage support",
      description:
        "Allows changing a conversation's status, priority and category, linking or unlinking a related order, and resolving or reopening it.",
    },
    "support.assign": {
      category: "Support",
      label: "Assign support",
      description:
        "Allows assigning a conversation to a staff member, taking it, or leaving it unassigned. Only staff who can already view support may be assigned.",
    },
    "automation.view": {
      category: "Operations",
      label: "View automation",
      description:
        "Allows seeing scheduled reminders, whether the scheduler is running, and which jobs have failed. Does not allow changing timing or retrying anything.",
    },
    "automation.manage": {
      category: "Operations",
      label: "Manage automation",
      description:
        "Allows changing reminder timing, enabling or disabling optional reminders, and retrying or cancelling a scheduled job. Grant this deliberately: the thresholds decide when real customers are emailed.",
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
    /*
     * The four support permissions, on the role that is literally called
     * Support — `is_staff`, ranked 40, and holding **zero accounts** today, so
     * this defines the role rather than widening anybody's access.
     *
     * Deliberately not given to `moderator`: moderation is about community
     * content, and a moderator reading a customer's correspondence about a
     * refund by default is a wider grant than that role was created for. The
     * migration seeds the same four rows into `role_permissions`, which is the
     * real source of truth — this list is only the fallback for an install whose
     * permission table has not been seeded yet, and the two must agree.
     */
    "support.view",
    "support.reply",
    "support.manage",
    "support.assign",
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
