/**
 * The audit action taxonomy.
 *
 * Two rules hold this together:
 *
 * 1. **Stable machine names, friendly labels.** The database stores
 *    `order.status_changed` forever; the UI renders "Changed order status".
 *    Renaming a label is a copy change, not a data migration.
 *
 * 2. **One registry, not free text.** A `Record` keyed by the action string is
 *    what stops "order.status_change", "order.statusChanged" and
 *    "staff.order.status" from all appearing in the same filter dropdown.
 *
 * KeyMoura already had a live taxonomy — `staff.`, `admin.` and `moderation.`
 * prefixed types across 115 call sites and 46 recorded events — so the legacy
 * names are registered here too rather than rewritten. Old rows keep their
 * meaning and gain a readable label.
 *
 * This module is deliberately free of imports so it can be unit-tested with
 * `node --experimental-strip-types` and reused on both the server and client.
 */

export const AUDIT_AREAS = [
  "orders",
  "production",
  "fulfillment",
  "inventory",
  "catalog",
  "security",
  "settings",
  "communications",
  "moderation",
  "system",
] as const;

export type AuditArea = (typeof AUDIT_AREAS)[number];

export const AUDIT_AREA_LABELS: Readonly<Record<AuditArea, string>> = {
  orders: "Orders",
  production: "Production",
  fulfillment: "Fulfillment",
  inventory: "Inventory",
  catalog: "Catalog",
  security: "Security",
  settings: "Settings",
  communications: "Communications",
  moderation: "Moderation",
  system: "System",
};

/**
 * What an event is *about*. Drives the "Open order" / "Open product" links on
 * the detail view, so a value here is a promise that a link can be built.
 */
export type AuditEntityType =
  | "order"
  | "production_job"
  | "product"
  | "category"
  | "discount"
  | "user"
  | "role"
  | "setting"
  | "email_template"
  | "email_delivery"
  | "report"
  | "thread"
  | "post"
  | "restriction"
  | "other";

export type AuditActionDefinition = {
  /** Sentence-case, past tense, no object — the object is rendered separately. */
  label: string;
  area: AuditArea;
  entityType: AuditEntityType;
  /**
   * Security-sensitive actions are called out in the UI and are the ones whose
   * audit write is treated as strictly as the mutation itself.
   */
  sensitive?: boolean;
};

/**
 * The canonical taxonomy. New instrumentation uses these names.
 */
export const AUDIT_ACTIONS = {
  // --- Orders -------------------------------------------------------------
  "order.created": { label: "Created order", area: "orders", entityType: "order" },
  "order.status_changed": { label: "Changed order status", area: "orders", entityType: "order" },
  "order.price_changed": { label: "Changed order price", area: "orders", entityType: "order" },
  "order.quote_changed": { label: "Revised quote", area: "orders", entityType: "order" },
  "order.deposit_changed": { label: "Changed deposit", area: "orders", entityType: "order" },
  "order.schedule_changed": { label: "Changed order dates", area: "orders", entityType: "order" },
  "order.fulfillment_method_changed": {
    label: "Changed fulfillment method",
    area: "orders",
    entityType: "order",
  },
  "order.updated": { label: "Updated order", area: "orders", entityType: "order" },
  "order.cancelled": { label: "Cancelled order", area: "orders", entityType: "order" },
  "order.refund_requested": { label: "Requested refund", area: "orders", entityType: "order", sensitive: true },
  "order.refunded": { label: "Refunded order", area: "orders", entityType: "order", sensitive: true },
  "order.payment_status_changed": {
    label: "Changed payment status",
    area: "orders",
    entityType: "order",
    sensitive: true,
  },

  // --- Production ---------------------------------------------------------
  "production.created": { label: "Created production job", area: "production", entityType: "production_job" },
  "production.linked_to_order": {
    label: "Linked production job to order",
    area: "production",
    entityType: "production_job",
  },
  "production.relinked_to_order": {
    label: "Re-linked production job to a different order",
    area: "production",
    entityType: "production_job",
  },
  "production.unlinked_from_order": {
    label: "Unlinked production job from order",
    area: "production",
    entityType: "production_job",
  },
  "production.status_changed": {
    label: "Changed production status",
    area: "production",
    entityType: "production_job",
  },
  "production.priority_changed": {
    label: "Changed production priority",
    area: "production",
    entityType: "production_job",
  },
  "production.due_date_changed": {
    label: "Changed production due date",
    area: "production",
    entityType: "production_job",
  },
  "production.blocker_changed": {
    label: "Changed production blocker",
    area: "production",
    entityType: "production_job",
  },
  "production.qc_changed": { label: "Recorded QC result", area: "production", entityType: "production_job" },
  "production.quantity_changed": {
    label: "Changed production quantity",
    area: "production",
    entityType: "production_job",
  },
  "production.updated": { label: "Updated production job", area: "production", entityType: "production_job" },
  "production.cancelled": { label: "Cancelled production job", area: "production", entityType: "production_job" },

  // --- Fulfillment --------------------------------------------------------
  "fulfillment.status_changed": { label: "Changed fulfillment status", area: "fulfillment", entityType: "order" },
  "fulfillment.tracking_changed": { label: "Changed tracking details", area: "fulfillment", entityType: "order" },
  "fulfillment.shipped": { label: "Marked shipped", area: "fulfillment", entityType: "order" },
  "fulfillment.ready_for_pickup": { label: "Marked ready for pickup", area: "fulfillment", entityType: "order" },
  "fulfillment.picked_up": { label: "Recorded pickup", area: "fulfillment", entityType: "order" },
  "fulfillment.delivered": { label: "Marked delivered", area: "fulfillment", entityType: "order" },

  // --- Inventory ----------------------------------------------------------
  "inventory.adjusted": { label: "Adjusted inventory", area: "inventory", entityType: "product" },
  "inventory.reserved": { label: "Reserved stock", area: "inventory", entityType: "product" },
  "inventory.released": { label: "Released stock", area: "inventory", entityType: "product" },
  "inventory.committed": { label: "Committed stock", area: "inventory", entityType: "product" },
  "inventory.restored": { label: "Restored stock", area: "inventory", entityType: "product" },

  // --- Catalog ------------------------------------------------------------
  "product.created": { label: "Created product", area: "catalog", entityType: "product" },
  "product.updated": { label: "Updated product", area: "catalog", entityType: "product" },
  "product.price_changed": { label: "Changed product price", area: "catalog", entityType: "product" },
  "product.published": { label: "Published product", area: "catalog", entityType: "product" },
  "product.unpublished": { label: "Unpublished product", area: "catalog", entityType: "product" },
  "product.archived": { label: "Archived product", area: "catalog", entityType: "product" },
  "product.restored": { label: "Restored product", area: "catalog", entityType: "product" },
  "product.deleted": { label: "Deleted product", area: "catalog", entityType: "product" },
  "category.created": { label: "Created category", area: "catalog", entityType: "category" },
  "category.updated": { label: "Updated category", area: "catalog", entityType: "category" },
  "category.deleted": { label: "Deleted category", area: "catalog", entityType: "category" },
  "discount.created": { label: "Created discount code", area: "catalog", entityType: "discount" },
  "discount.updated": { label: "Updated discount code", area: "catalog", entityType: "discount" },
  "discount.deleted": { label: "Deleted discount code", area: "catalog", entityType: "discount" },

  // --- Security -----------------------------------------------------------
  "role.created": { label: "Created role", area: "security", entityType: "role", sensitive: true },
  "role.updated": { label: "Updated role", area: "security", entityType: "role", sensitive: true },
  "role.deleted": { label: "Deleted role", area: "security", entityType: "role", sensitive: true },
  "role.assigned": { label: "Assigned role", area: "security", entityType: "user", sensitive: true },
  "role.removed": { label: "Removed role", area: "security", entityType: "user", sensitive: true },
  "permission.changed": { label: "Changed permissions", area: "security", entityType: "role", sensitive: true },

  // --- User management ----------------------------------------------------
  //
  // `user.` (singular) is the subject of the change; `users.` (plural) is the
  // legacy prefix for actions *about the collection*, like `users.create`. Both
  // resolve to the same area, so the distinction costs a reader nothing.
  "user.profile_changed": { label: "Changed profile details", area: "security", entityType: "user" },
  "user.note_created": { label: "Added a staff note", area: "security", entityType: "user" },
  "user.note_archived": { label: "Archived a staff note", area: "security", entityType: "user" },
  // Filed under moderation rather than security so it sits with the ban and
  // restriction events that actually carry it out — a suspension is one thing
  // whichever screen it was pressed from.
  "user.status_changed": {
    label: "Changed account status",
    area: "moderation",
    entityType: "user",
    sensitive: true,
  },

  // --- Settings -----------------------------------------------------------
  "settings.commerce_changed": { label: "Changed commerce settings", area: "settings", entityType: "setting" },
  "settings.fulfillment_changed": {
    label: "Changed fulfillment settings",
    area: "settings",
    entityType: "setting",
  },
  "settings.appearance_changed": { label: "Updated appearance settings", area: "settings", entityType: "setting" },

  // --- Communications -----------------------------------------------------
  "email.template_changed": { label: "Edited email template", area: "communications", entityType: "email_template" },
  "email.manual_resend": { label: "Re-sent email", area: "communications", entityType: "email_delivery" },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/**
 * Legacy event types, kept working rather than rewritten.
 *
 * These names are already in the database and in 115 call sites. Renaming them
 * would either orphan the 46 existing rows or require rewriting history, and
 * rewriting history is the one thing an audit log must never do.
 */
const LEGACY_ACTIONS: Readonly<Record<string, AuditActionDefinition>> = {
  "staff.order.cancellation_requested": { label: "Requested cancellation", area: "orders", entityType: "order" },
  "staff.order.cancellation_withdrawn": { label: "Withdrew cancellation", area: "orders", entityType: "order" },
  "staff.order.cancellation_approved": { label: "Approved cancellation", area: "orders", entityType: "order" },
  "staff.order.cancellation_denied": { label: "Declined cancellation", area: "orders", entityType: "order" },
  "staff.order.cancelled": { label: "Cancelled order", area: "orders", entityType: "order" },
  "staff.order.refund_requested": { label: "Requested refund", area: "orders", entityType: "order", sensitive: true },
  "staff.order.refund_sent": { label: "Sent refund to Stripe", area: "orders", entityType: "order", sensitive: true },
  "staff.order.refund_confirmed": { label: "Refund confirmed", area: "orders", entityType: "order", sensitive: true },
  "staff.order.refund_failed": { label: "Refund failed", area: "orders", entityType: "order", sensitive: true },
  "staff.order.return_requested": { label: "Requested return", area: "orders", entityType: "order" },
  "staff.order.return_approved": { label: "Approved return", area: "orders", entityType: "order" },
  "staff.order.return_denied": { label: "Declined return", area: "orders", entityType: "order" },
  "staff.order.return_received": { label: "Recorded return receipt", area: "orders", entityType: "order" },
  "staff.order.return_inspected": { label: "Inspected return", area: "orders", entityType: "order" },
  "staff.order.return_closed": { label: "Closed return", area: "orders", entityType: "order" },
  "staff.order.fulfillment_changed": {
    label: "Changed fulfillment status",
    area: "fulfillment",
    entityType: "order",
  },
  "staff.order.tracking_added": { label: "Added tracking details", area: "fulfillment", entityType: "order" },
  "staff.order.tracking_corrected": { label: "Corrected tracking details", area: "fulfillment", entityType: "order" },
  "staff.order.email_resent": { label: "Re-sent email", area: "communications", entityType: "order" },
  "staff.inventory.adjusted": { label: "Adjusted inventory", area: "inventory", entityType: "product" },
  "staff.inventory.committed": { label: "Committed stock", area: "inventory", entityType: "product" },
  "staff.inventory.restored": { label: "Restored stock", area: "inventory", entityType: "product" },
  "staff.commerce.policy_changed": { label: "Changed commerce policy", area: "settings", entityType: "setting" },
  "staff.commerce.settings_changed": { label: "Changed commerce settings", area: "settings", entityType: "setting" },
  "staff.appearance.update": { label: "Updated appearance settings", area: "settings", entityType: "setting" },
  "staff.catalog.category.create": { label: "Created category", area: "catalog", entityType: "category" },
  "staff.catalog.category.update": { label: "Updated category", area: "catalog", entityType: "category" },
  "staff.catalog.category.delete": { label: "Deleted category", area: "catalog", entityType: "category" },
  "staff.catalog.discount.create": { label: "Created discount code", area: "catalog", entityType: "discount" },
  "staff.catalog.discount.update": { label: "Updated discount code", area: "catalog", entityType: "discount" },
  "staff.catalog.discount.delete": { label: "Deleted discount code", area: "catalog", entityType: "discount" },
  "staff.production.job.create": { label: "Created production job", area: "production", entityType: "production_job" },
  "staff.email.update": { label: "Edited email template", area: "communications", entityType: "email_template" },
  "staff.payments.discrepancy_reviewed": {
    label: "Reviewed payment discrepancy",
    area: "orders",
    entityType: "order",
  },
  "staff.launch.acknowledged": { label: "Acknowledged launch warning", area: "system", entityType: "other" },
  "staff.launch.acknowledgement_cleared": {
    label: "Cleared launch acknowledgement",
    area: "system",
    entityType: "other",
  },
  "admin.roles.set": { label: "Assigned role", area: "security", entityType: "user", sensitive: true },
  "admin.roles.request": { label: "Requested role change", area: "security", entityType: "user", sensitive: true },
  "admin.security.settings.apply": {
    label: "Changed security settings",
    area: "security",
    entityType: "setting",
    sensitive: true,
  },
  "staff.email.resend": { label: "Re-sent email", area: "communications", entityType: "email_delivery" },
  "staff.catalog.category.reorder": { label: "Reordered categories", area: "catalog", entityType: "category" },
  "staff.catalog.category.move_products": {
    label: "Moved products between categories",
    area: "catalog",
    entityType: "category",
  },
  "staff.catalog.discount.archive": { label: "Archived discount code", area: "catalog", entityType: "discount" },
  "staff.appearance.template.create": { label: "Created appearance template", area: "settings", entityType: "setting" },
  "staff.appearance.template.rename": { label: "Renamed appearance template", area: "settings", entityType: "setting" },
  "staff.appearance.template.delete": { label: "Deleted appearance template", area: "settings", entityType: "setting" },

  // Security and approvals
  "admin.approvals.approve": { label: "Approved a queued action", area: "security", entityType: "other", sensitive: true },
  "admin.approvals.reject": { label: "Rejected a queued action", area: "security", entityType: "other", sensitive: true },
  "admin.approvals.override_approve": {
    label: "Overrode approval and applied a queued action",
    area: "security",
    entityType: "other",
    sensitive: true,
  },
  "admin.ban_user.apply": { label: "Banned a user", area: "moderation", entityType: "user", sensitive: true },
  "admin.ban_user.request": { label: "Requested a ban", area: "moderation", entityType: "user" },
  "admin.notifications.broadcast.request": {
    label: "Requested a broadcast notification",
    area: "security",
    entityType: "other",
  },
  "admin.security.broadcast.request": { label: "Requested a security broadcast", area: "security", entityType: "other", sensitive: true },
  "admin.security.force_logout.request": {
    label: "Requested a forced logout",
    area: "security",
    entityType: "user",
    sensitive: true,
  },
  "security.account_delete": { label: "Deleted an account", area: "security", entityType: "user", sensitive: true },
  "users.create": { label: "Created a user account", area: "security", entityType: "user", sensitive: true },

  // Moderation
  "moderation.report.update": { label: "Updated a report", area: "moderation", entityType: "report" },
  "moderation.report.bulk_update": { label: "Bulk-updated reports", area: "moderation", entityType: "report" },
  "moderation.report.escalate": { label: "Escalated a report", area: "moderation", entityType: "report" },
  "moderation.report.descalate": { label: "De-escalated a report", area: "moderation", entityType: "report" },
  "moderation.restriction.set": { label: "Applied a restriction", area: "moderation", entityType: "restriction" },
  "moderation.restriction.clear": { label: "Cleared a restriction", area: "moderation", entityType: "restriction" },
  "moderation.restriction.request": { label: "Requested a restriction", area: "moderation", entityType: "restriction" },
  "moderation.dm_message.delete": { label: "Deleted a direct message", area: "moderation", entityType: "post" },
  "moderation.recycle_bin.restore": { label: "Restored from the recycle bin", area: "moderation", entityType: "post" },
  "forum.post_delete": { label: "Deleted a post", area: "moderation", entityType: "post" },
  "forum.thread_delete": { label: "Deleted a thread", area: "moderation", entityType: "thread" },
  "community.category_create": { label: "Created a community category", area: "moderation", entityType: "other" },

  // Info pages
  "admin.info_page_update.approve": { label: "Approved an info page update", area: "moderation", entityType: "other" },
  "admin.info_page_update.reject": { label: "Rejected an info page update", area: "moderation", entityType: "other" },
  "admin.info_page_update.edit": { label: "Edited an info page update", area: "moderation", entityType: "other" },
  "admin.info_page_update.forward": { label: "Forwarded an info page update", area: "moderation", entityType: "other" },
  "admin.info_page_update.note": { label: "Noted an info page update", area: "moderation", entityType: "other" },
};

/**
 * Which area a prefix belongs to when the exact action is not registered.
 * Ordered longest-first at lookup so `staff.order.` beats `staff.`.
 */
const PREFIX_AREAS: ReadonlyArray<readonly [string, AuditArea, AuditEntityType]> = [
  ["order.", "orders", "order"],
  ["staff.order.", "orders", "order"],
  ["production.", "production", "production_job"],
  ["staff.production.", "production", "production_job"],
  ["fulfillment.", "fulfillment", "order"],
  ["inventory.", "inventory", "product"],
  ["staff.inventory.", "inventory", "product"],
  ["product.", "catalog", "product"],
  ["category.", "catalog", "category"],
  ["discount.", "catalog", "discount"],
  ["staff.catalog.", "catalog", "other"],
  ["role.", "security", "user"],
  ["permission.", "security", "role"],
  ["admin.roles.", "security", "user"],
  ["admin.security.", "security", "setting"],
  ["security.", "security", "other"],
  ["approvals.", "security", "other"],
  ["admin.approvals.", "security", "other"],
  ["settings.", "settings", "setting"],
  ["staff.commerce.", "settings", "setting"],
  ["staff.appearance.", "settings", "setting"],
  ["email.", "communications", "email_template"],
  ["staff.email.", "communications", "email_template"],
  ["moderation.", "moderation", "other"],
  ["admin.moderation.", "moderation", "other"],
  ["staff.moderation.", "moderation", "other"],
  ["admin.reports.", "moderation", "report"],
  ["staff.reports.", "moderation", "report"],
  ["community.", "moderation", "thread"],
  ["forum.", "moderation", "thread"],
  ["user.", "security", "user"],
  ["users.", "security", "user"],
  ["staff.launch.", "system", "other"],
  ["admin.", "security", "other"],
  ["staff.", "system", "other"],
];

/** Turns `some.unregistered_action` into "Some unregistered action". */
function humanizeAction(action: string): string {
  const tail = action.includes(".") ? action.slice(action.lastIndexOf(".") + 1) : action;
  const words = tail.replaceAll("_", " ").trim();
  if (!words) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Resolves any action string — canonical, legacy, or one this build has never
 * seen — into something renderable.
 *
 * Never throws and never returns an empty label. An audit row written by a
 * newer deployment must still be readable by an older one; a log that hides
 * rows it does not recognise is worse than a log with an ugly label.
 */
export function describeAction(action: string): AuditActionDefinition {
  const canonical = (AUDIT_ACTIONS as Record<string, AuditActionDefinition | undefined>)[action];
  if (canonical) return canonical;

  const legacy = LEGACY_ACTIONS[action];
  if (legacy) return legacy;

  let best: readonly [string, AuditArea, AuditEntityType] | null = null;
  for (const candidate of PREFIX_AREAS) {
    if (!action.startsWith(candidate[0])) continue;
    if (!best || candidate[0].length > best[0].length) best = candidate;
  }

  return {
    label: humanizeAction(action),
    area: best ? best[1] : "system",
    entityType: best ? best[2] : "other",
  };
}

/** Friendly label only. */
export function actionLabel(action: string): string {
  return describeAction(action).label;
}

/** The area an action belongs to, for filtering. */
export function actionArea(action: string): AuditArea {
  return describeAction(action).area;
}

/**
 * Every action string this build knows about, canonical and legacy, sorted.
 * Used to populate the action filter without querying `distinct event_type`
 * over the whole table.
 */
export function knownActions(): string[] {
  return [...Object.keys(AUDIT_ACTIONS), ...Object.keys(LEGACY_ACTIONS)].sort((a, b) => a.localeCompare(b));
}

/** Actions belonging to one area, for the dependent action dropdown. */
export function actionsForArea(area: AuditArea): string[] {
  return knownActions().filter((action) => describeAction(action).area === area);
}
