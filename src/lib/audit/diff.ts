/**
 * The safe diff helper.
 *
 * One place decides what a change *is*, which fields may be recorded, and how a
 * recorded value reads on screen. Three rules:
 *
 * 1. **Allowlist, never "everything that differs".** A JSONB column is not a
 *    reason to snapshot rows. Callers name the fields they mean.
 * 2. **Sensitive keys are refused even when allowlisted.** A future caller
 *    adding `password_hash` to its field list gets nothing rather than a leak —
 *    the deny check runs after the allowlist, not before it.
 * 3. **Cents in, currency out.** The change set stores integers; only the
 *    formatter turns 4500 into "$45.00". Storing "$45.00" would make the log
 *    unqueryable and locale-dependent forever.
 *
 * Dependency-free apart from the domain vocabularies, so it is unit-testable
 * with `node --experimental-strip-types` and safe to import in the browser.
 */

import { PRIORITY_META, STATUS_META } from "../production/jobs.ts";

export type AuditValue = string | number | boolean | null;

export type FieldChange = {
  before: AuditValue;
  after: AuditValue;
  /**
   * Set when the value is too large to keep — the change is recorded as a
   * length rather than a body. The `products` trigger uses this for marketing
   * copy and `detail_content`.
   */
  summarized?: boolean;
};

export type ChangeSet = Record<string, FieldChange>;

// ---------------------------------------------------------------------------
// Sensitive fields
// ---------------------------------------------------------------------------

/**
 * Never recorded, whatever the caller asks for.
 *
 * Matched against the field name, case-insensitively, as a substring. The list
 * is deliberately specific: a blanket `/code/` would swallow `reason_code`,
 * `tax_code` and `discount_code`, all of which are exactly the sort of thing an
 * audit log exists to record.
 */
const SENSITIVE_FIELD_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /access[_-]?key/i,
  /private[_-]?key/i,
  /service[_-]?role/i,
  /credential/i,
  /session/i,
  /cookie/i,
  /authorization/i,
  /auth[_-]?header/i,
  /bearer/i,
  /verification[_-]?code/i,
  /otp/i,
  /\bcvv\b/i,
  /card[_-]?number/i,
  /\bssn\b/i,
  /signing[_-]?key/i,
  /webhook[_-]?secret/i,
];

/** True when a field must never reach the audit log. */
export function isSensitiveField(field: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(field));
}

// ---------------------------------------------------------------------------
// Field presentation
// ---------------------------------------------------------------------------

export type AuditFieldFormat = "text" | "money" | "date" | "datetime" | "boolean" | "number" | "enum";

export type AuditFieldSpec = {
  label: string;
  format?: AuditFieldFormat;
  /** Enum value → friendly label. */
  values?: Readonly<Record<string, string>>;
};

const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  requested: "Requested",
  needs_information: "Needs information",
  accepted: "Accepted",
  awaiting_payment: "Awaiting payment",
  in_progress: "In production",
  customer_review: "Customer review",
  final_review: "Final review",
  ready: "Ready",
  completed: "Completed",
  declined: "Declined",
  cancelled: "Cancelled",
};

const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_required: "Not required",
  unpaid: "Unpaid",
  payment_pending: "Payment pending",
  partial: "Partially paid",
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
  payment_failed: "Payment failed",
  payment_canceled: "Payment canceled",
};

const FULFILLMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_required: "Not required",
  unfulfilled: "Unfulfilled",
  processing: "Processing",
  ready_to_fulfill: "Ready to fulfill",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
  shipped: "Shipped",
  delivered: "Delivered",
  returned: "Returned",
  partially_returned: "Partially returned",
  canceled: "Canceled",
};

// Derived from the production domain rather than restated, so a status renamed
// on the shop floor is renamed here too.
const PRODUCTION_STATUS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STATUS_META).map(([value, meta]) => [value, meta.label])
);

const PRODUCTION_PRIORITY_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PRIORITY_META).map(([value, meta]) => [value, (meta as { label: string }).label])
);

/**
 * How each known field is titled and rendered.
 *
 * A field absent from this map still diffs correctly — it just gets a
 * humanized label and format inferred from its name. The map exists to make the
 * common ones read well, not to gate what may be recorded.
 */
export const AUDIT_FIELD_SPECS: Readonly<Record<string, AuditFieldSpec>> = {
  // Orders
  status: { label: "Status", format: "enum", values: ORDER_STATUS_LABELS },
  payment_status: { label: "Payment status", format: "enum", values: PAYMENT_STATUS_LABELS },
  fulfillment_status: { label: "Fulfillment status", format: "enum", values: FULFILLMENT_STATUS_LABELS },
  fulfillment_method: { label: "Fulfillment method", format: "enum", values: { shipping: "Shipping", pickup: "Pickup", none: "None" } },
  agreed_price_cents: { label: "Agreed price", format: "money" },
  deposit_amount_cents: { label: "Deposit", format: "money" },
  quote_revision: { label: "Quote revision", format: "number" },
  quote_expires_at: { label: "Quote expires", format: "datetime" },
  target_date: { label: "Target date", format: "date" },
  cancellation_reason: { label: "Cancellation reason", format: "text" },
  shipping_carrier: { label: "Carrier", format: "text" },
  tracking_number: { label: "Tracking number", format: "text" },
  tracking_url: { label: "Tracking link", format: "text" },

  // Production
  priority: { label: "Priority", format: "enum", values: PRODUCTION_PRIORITY_LABELS },
  due_date: { label: "Due date", format: "date" },
  promised_date: { label: "Promised date", format: "date" },
  quantity: { label: "Quantity", format: "number" },
  assigned_to: { label: "Assigned to", format: "text" },
  hold_reason: { label: "Blocker", format: "text" },
  failure_reason: { label: "QC failure reason", format: "text" },
  materials_acquired: { label: "Materials acquired", format: "boolean" },
  estimated_minutes: { label: "Estimated minutes", format: "number" },
  order_id: { label: "Linked order", format: "text" },

  // Inventory
  quantity_before: { label: "Quantity before", format: "number" },
  quantity_after: { label: "Quantity after", format: "number" },
  delta: { label: "Change", format: "number" },
  inventory_quantity: { label: "On hand", format: "number" },
  low_stock_threshold: { label: "Low stock threshold", format: "number" },
  inventory_policy: { label: "Inventory policy", format: "enum", values: { track: "Tracked", unlimited: "Not tracked" } },
  continue_selling_when_out_of_stock: { label: "Backorders allowed", format: "boolean" },

  // Catalog
  name: { label: "Name", format: "text" },
  slug: { label: "Slug", format: "text" },
  sku: { label: "SKU", format: "text" },
  starting_price_cents: { label: "Price", format: "money" },
  is_published: { label: "Published", format: "boolean" },
  archived_at: { label: "Archived", format: "datetime" },
  category_id: { label: "Category", format: "text" },
  category: { label: "Category", format: "text" },
  purchase_mode: {
    label: "Purchase mode",
    format: "enum",
    values: { direct: "Buy now", request_only: "Request only", both: "Buy or request" },
  },
  made_to_order: { label: "Made to order", format: "boolean" },
  is_custom: { label: "Custom", format: "boolean" },
  is_returnable: { label: "Returnable", format: "boolean" },
  requires_shipping: { label: "Requires shipping", format: "boolean" },
  pickup_eligible: { label: "Pickup eligible", format: "boolean" },
  fulfillment_required: { label: "Fulfillment required", format: "boolean" },
  availability_status: { label: "Availability", format: "text" },
  lead_time_text: { label: "Lead time", format: "text" },
  image_url: { label: "Primary image", format: "text" },
  model_url: { label: "3D model", format: "text" },
  sort_order: { label: "Sort order", format: "number" },
  short_description: { label: "Short description", format: "text" },
  description: { label: "Description", format: "text" },
  detail_content: { label: "Detail content", format: "text" },
  material: { label: "Material", format: "text" },
  finish: { label: "Finish", format: "text" },
  tax_code: { label: "Tax code", format: "text" },

  // Security
  role: { label: "Role", format: "text" },
  permissions: { label: "Permissions", format: "text" },
};

/**
 * Per-entity overrides, because the same column name means different things.
 *
 * `orders.status` and `production_jobs.status` are both `status`, and they
 * share the value `in_progress` — which the shop floor calls "In progress" and
 * the customer-facing order calls "In production". A single global map would
 * render one of them wrong on every row, and it would look plausible, which is
 * the dangerous kind of wrong for an audit log.
 */
const ENTITY_FIELD_OVERRIDES: Readonly<Record<string, Readonly<Record<string, AuditFieldSpec>>>> = {
  production_job: {
    status: { label: "Status", format: "enum", values: PRODUCTION_STATUS_LABELS },
    order_id: { label: "Linked order", format: "text" },
    title: { label: "Title", format: "text" },
  },
};

/** Turns `low_stock_threshold` into "Low stock threshold". */
function humanizeField(field: string): string {
  const words = field.replaceAll("_", " ").replace(/\bcents\b/i, "").trim();
  if (!words) return field;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The spec for a field, inferring a sensible one when it is not registered.
 * Inference is by suffix — `_cents` is money, `_at` is a timestamp, `_date` is
 * a date — which covers most of the schema's naming conventions.
 */
export function fieldSpec(field: string, entityType?: string | null): AuditFieldSpec {
  const override = entityType ? ENTITY_FIELD_OVERRIDES[entityType]?.[field] : undefined;
  if (override) return override;

  const known = AUDIT_FIELD_SPECS[field];
  if (known) return known;

  if (field.endsWith("_cents")) return { label: humanizeField(field), format: "money" };
  if (field.endsWith("_at")) return { label: humanizeField(field), format: "datetime" };
  if (field.endsWith("_date")) return { label: humanizeField(field), format: "date" };
  return { label: humanizeField(field), format: "text" };
}

export function fieldLabel(field: string, entityType?: string | null): string {
  return fieldSpec(field, entityType).label;
}

// ---------------------------------------------------------------------------
// Building a change set
// ---------------------------------------------------------------------------

/**
 * `null`, `undefined` and `""` all mean "not set".
 *
 * Without this, clearing a text box that was already empty records a change
 * from `null` to `""` — a diff nobody made and nobody can act on.
 */
function normalize(value: unknown): AuditValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  // Objects and arrays are not diffed field-by-field here: a caller that wants
  // one audited names the specific scalar it cares about.
  return null;
}

export type BuildChangeSetOptions = {
  /** Maximum characters kept for a text value before it is summarized. */
  maxTextLength?: number;
};

/**
 * Compares two records over an explicit field list and returns only what moved.
 *
 * Returns `{}` when nothing changed — callers use that to decide there is no
 * event to write, which is what keeps a no-op save out of the log.
 */
export function buildChangeSet(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
  fields: readonly string[],
  options: BuildChangeSetOptions = {}
): ChangeSet {
  const maxTextLength = options.maxTextLength ?? 200;
  const changes: ChangeSet = {};

  for (const field of fields) {
    // The allowlist decides what is considered; this decides what is allowed.
    // Order matters: a caller cannot opt a secret back in.
    if (isSensitiveField(field)) continue;

    const beforeValue = normalize(before ? before[field] : null);
    const afterValue = normalize(after ? after[field] : null);
    if (beforeValue === afterValue) continue;

    const beforeLong = typeof beforeValue === "string" && beforeValue.length > maxTextLength;
    const afterLong = typeof afterValue === "string" && afterValue.length > maxTextLength;

    if (beforeLong || afterLong) {
      changes[field] = {
        before: typeof beforeValue === "string" ? beforeValue.length : beforeValue,
        after: typeof afterValue === "string" ? afterValue.length : afterValue,
        summarized: true,
      };
      continue;
    }

    changes[field] = { before: beforeValue, after: afterValue };
  }

  return changes;
}

/** True when a change set carries nothing — i.e. the save was a no-op. */
export function isEmptyChangeSet(changes: ChangeSet | null | undefined): boolean {
  return !changes || Object.keys(changes).length === 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const NOT_SET = "—";

function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatDate(value: string, withTime: boolean): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return withTime
    ? parsed.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * One value, as a staff member should read it.
 *
 * `summarized` values are lengths, not content, so they render as a character
 * count rather than pretending to be the text.
 */
export function formatAuditValue(
  field: string,
  value: AuditValue,
  summarized = false,
  entityType?: string | null
): string {
  if (value === null) return NOT_SET;

  if (summarized) {
    return typeof value === "number" ? `${value.toLocaleString()} characters` : String(value);
  }

  const spec = fieldSpec(field, entityType);

  if (spec.values && typeof value === "string") {
    const mapped = spec.values[value];
    if (mapped) return mapped;
  }

  switch (spec.format) {
    case "money":
      return typeof value === "number" ? formatMoney(value) : String(value);
    case "date":
      return typeof value === "string" ? formatDate(value, false) : String(value);
    case "datetime":
      return typeof value === "string" ? formatDate(value, true) : String(value);
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    default:
      break;
  }

  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    // A raw uuid in the summary line helps nobody. The detail view's Advanced
    // section shows the full value.
    return `${value.slice(0, 8)}…`;
  }
  return String(value);
}

export type RenderedChange = {
  field: string;
  label: string;
  before: string;
  after: string;
  summarized: boolean;
};

/** A change set turned into rows a table can render, in a stable order. */
export function renderChanges(
  changes: ChangeSet | null | undefined,
  entityType?: string | null
): RenderedChange[] {
  if (!changes) return [];
  return Object.keys(changes)
    .sort((a, b) => fieldLabel(a, entityType).localeCompare(fieldLabel(b, entityType)))
    .map((field) => {
      const change = changes[field];
      const summarized = change.summarized === true;
      return {
        field,
        label: fieldLabel(field, entityType),
        before: formatAuditValue(field, change.before, summarized, entityType),
        after: formatAuditValue(field, change.after, summarized, entityType),
        summarized,
      };
    });
}

/**
 * The one-line summary shown on a log row.
 *
 * A single change reads as "In production → Ready for pickup". Several read as
 * "Status, Priority and 2 more", because five arrows on one row is not a
 * summary.
 */
export function summarizeChanges(
  changes: ChangeSet | null | undefined,
  entityType?: string | null
): string | null {
  const rendered = renderChanges(changes, entityType);
  if (!rendered.length) return null;

  if (rendered.length === 1) {
    const only = rendered[0];
    return `${only.before} → ${only.after}`;
  }

  const named = rendered.slice(0, 2).map((change) => change.label);
  const remaining = rendered.length - named.length;
  const list = named.join(", ");
  return remaining > 0 ? `${list} and ${remaining} more` : list;
}
