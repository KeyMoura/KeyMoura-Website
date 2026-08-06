import { isResendableTemplate, maskRecipient, type EmailTemplateKey } from "./emailEvents";

/**
 * The email delivery centre — filters, projection and resend eligibility.
 *
 * Pure and dependency-free, so the page, the route and the tests read the same
 * rules. The reason this is a module rather than route-local code is the one
 * pass 10 learned the hard way: a filter approximated in one place and computed
 * exactly in another is how a list disagrees with the count above it.
 */

/**
 * Every value `email_deliveries.status` may hold.
 *
 * This list and the CHECK constraint in `20260806030000_communications_center`
 * are the same set, and a test asserts it. One of them drifting is how a status
 * the code writes becomes a 23514 the first time a customer would have been
 * emailed — which is exactly what a live dry-run probe caught in this pass.
 */
export const DELIVERY_STATUSES = ["queued", "sent", "delivered", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * States only the provider can put a row into.
 *
 * `delivered` needs a Resend delivery webhook, which is **not wired**. The
 * value is legal so the claim logic can treat it as "the customer has it" and
 * so wiring that webhook later is a code change rather than another constraint
 * change on a live table — but nothing in this application produces one today.
 */
export const PROVIDER_CONFIRMED_STATUSES: readonly DeliveryStatus[] = ["delivered"];

/**
 * The statuses worth offering as a filter.
 *
 * Derived by subtraction rather than written out again, so it cannot drift from
 * the full list. `delivered` is excluded because a filter that always returns
 * nothing reads as "nothing has been delivered", when the truth is that this
 * shop does not track delivery confirmation at all. Those are very different
 * statements and the first one is a lie.
 */
export const FILTERABLE_DELIVERY_STATUSES: readonly DeliveryStatus[] = DELIVERY_STATUSES.filter(
  (status) => !PROVIDER_CONFIRMED_STATUSES.includes(status)
);

export const DELIVERY_STATUS_LABELS: Readonly<Record<DeliveryStatus, string>> = {
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  // Stored as `skipped` since the table was created. Relabelled rather than
  // renamed: a rename would migrate 26 live rows to say the same thing.
  skipped: "Suppressed",
};

/**
 * What each status actually means, shown beside the filter.
 *
 * "Suppressed" is the one worth spelling out: it is not a failure. It means
 * this application deliberately did not send — the recipient was not
 * configured, the template was switched off, or the provider key was absent.
 * Reading those as failures is how somebody spends an afternoon debugging a
 * mail server that was working.
 */
export const DELIVERY_STATUS_HELP: Readonly<Record<DeliveryStatus, string>> = {
  queued: "Claimed and in flight, or interrupted before the provider answered.",
  sent: "Accepted by the provider. This is as far as delivery is tracked here.",
  delivered:
    "Confirmed delivered by the provider. Delivery confirmation is not wired, so no message reaches this state today.",
  failed: "The provider refused it. The category says why; the message is kept for diagnosis.",
  skipped: "Deliberately not sent — no recipient, the template is off, or email is not configured.",
};

export const FAILURE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  not_configured: "Email is not configured",
  disabled: "Sending is switched off",
  invalid_recipient: "The address was rejected",
  provider_rejected: "The provider refused the message",
  provider_unavailable: "The provider could not be reached",
  rate_limited: "Rate limited",
  unknown: "Unclassified",
};

export type DeliveryFilters = {
  status: DeliveryStatus[];
  templateKey: string[];
  audience: ("customer" | "staff")[];
  /** Free text matched against the order number, never against the recipient. */
  search: string;
  from: string | null;
  to: string | null;
  page: number;
};

export const DEFAULT_DELIVERY_FILTERS: DeliveryFilters = {
  status: [],
  templateKey: [],
  audience: [],
  search: "",
  from: null,
  to: null,
  page: 1,
};

export const DELIVERY_PAGE_SIZE = 25;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date is valid only if it round-trips.
 *
 * `new Date("2026-02-31")` is not an error in JavaScript; it rolls forward to
 * March. The pass-5 production date parser had exactly this bug, where an
 * impossible date typed by staff was accepted as a real one weeks away.
 */
function validDate(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!ISO_DATE.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

const readList = <T extends string>(raw: string[] | undefined, allowed: readonly T[]): T[] =>
  [...new Set((raw ?? []).filter((value): value is T => (allowed as readonly string[]).includes(value)))].sort();

/**
 * Parse filters from URL parameters.
 *
 * Total: any input at all yields usable filters. Unknown values are **dropped**
 * rather than passed through — a status the schema does not have is a filter
 * that silently matches nothing, which on screen is indistinguishable from
 * "there are no failures".
 */
export function parseDeliveryFilters(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
  knownTemplateKeys: readonly string[] = []
): DeliveryFilters {
  const get = (key: string): string[] => {
    if (params instanceof URLSearchParams) return params.getAll(key).flatMap((v) => v.split(",")).filter(Boolean);
    const value = (params as Record<string, string | string[] | undefined>)[key];
    if (Array.isArray(value)) return value.flatMap((v) => v.split(",")).filter(Boolean);
    return typeof value === "string" ? value.split(",").filter(Boolean) : [];
  };

  const from = validDate(get("from")[0]);
  const to = validDate(get("to")[0]);
  // An inverted range is a typo, not a request for zero rows.
  const [start, end] = from && to && from > to ? [to, from] : [from, to];

  const pageRaw = Number.parseInt(get("page")[0] ?? "1", 10);

  return {
    status: readList(get("status"), DELIVERY_STATUSES),
    templateKey: readList(get("template"), knownTemplateKeys),
    audience: readList(get("audience"), ["customer", "staff"] as const),
    search: (get("q")[0] ?? "").trim().slice(0, 80),
    from: start,
    to: end,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 400) : 1,
  };
}

/** Serialize filters back to a query string, canonically, so two equal filter sets produce one URL. */
export function deliveryFiltersToQuery(filters: DeliveryFilters): string {
  const params = new URLSearchParams();
  if (filters.status.length) params.set("status", filters.status.join(","));
  if (filters.templateKey.length) params.set("template", filters.templateKey.join(","));
  if (filters.audience.length) params.set("audience", filters.audience.join(","));
  if (filters.search) params.set("q", filters.search);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

/** The raw shape read from `email_deliveries`. */
export type DeliveryRow = {
  id: string;
  order_id: string | null;
  template_key: string | null;
  recipient: string;
  subject: string;
  status: string;
  provider_id: string | null;
  error_message: string | null;
  failure_category: string | null;
  event_key: string | null;
  audience: string | null;
  attempt_count: number | null;
  delivered_at: string | null;
  resend_of_id: string | null;
  created_at: string;
  updated_at: string | null;
};

/** What a staff client is allowed to see. */
export type DeliveryView = {
  id: string;
  orderId: string | null;
  orderNumber: string | null;
  templateKey: string | null;
  templateName: string;
  audience: "customer" | "staff" | "unknown";
  maskedRecipient: string;
  subject: string;
  status: DeliveryStatus | "unknown";
  statusLabel: string;
  failureSummary: string | null;
  attemptCount: number;
  createdAt: string;
  deliveredAt: string | null;
  isResend: boolean;
  resendOfId: string | null;
  canResend: boolean;
  resendBlockedReason: string | null;
};

/**
 * Project a stored delivery into what a staff surface may render.
 *
 * Three things deliberately do **not** cross this boundary:
 *
 *   * the full recipient address — masked, because this page is a list;
 *   * `provider_id` — a Resend message identifier is an internal handle and
 *     showing it invites pasting it somewhere it should not go;
 *   * `error_message` — the raw provider string, which can quote the address it
 *     refused. The *category* is shown instead, which is the part a staff
 *     member can act on.
 *
 * `event_key` also stays server-side: it is the idempotency key, and a key on a
 * screen is a key somebody can reuse.
 */
export function toDeliveryView(
  row: DeliveryRow,
  context: { orderNumbers?: Readonly<Record<string, string>>; templateNames?: Readonly<Record<string, string>> } = {}
): DeliveryView {
  const status = (DELIVERY_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as DeliveryStatus)
    : "unknown";
  const audience = row.audience === "customer" || row.audience === "staff" ? row.audience : "unknown";
  const resendable = row.template_key ? isResendableTemplate(row.template_key) : false;

  let blocked: string | null = null;
  if (!row.template_key) blocked = "This record has no template, so there is nothing to re-send.";
  else if (!resendable) blocked = "Staff alerts are not re-sendable. They go to a configured address, not to a person waiting on them.";
  else if (audience !== "customer") blocked = "Only a message addressed to a customer can be re-sent.";
  else if (status === "queued") blocked = "This send is still in flight. Wait for it to finish.";
  else if (!row.recipient || row.recipient === "not configured") blocked = "No recipient was recorded, so there is nowhere to send it.";

  return {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_id ? context.orderNumbers?.[row.order_id] ?? null : null,
    templateKey: row.template_key,
    templateName: (row.template_key && context.templateNames?.[row.template_key]) || row.template_key || "Unknown",
    audience,
    maskedRecipient: maskRecipient(row.recipient),
    subject: row.subject,
    status,
    statusLabel: status === "unknown" ? "Unknown" : DELIVERY_STATUS_LABELS[status],
    failureSummary:
      status === "failed" || status === "skipped"
        ? FAILURE_CATEGORY_LABELS[row.failure_category ?? "unknown"] ?? FAILURE_CATEGORY_LABELS.unknown
        : null,
    attemptCount: Math.max(1, row.attempt_count ?? 1),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    isResend: Boolean(row.resend_of_id),
    resendOfId: row.resend_of_id,
    canResend: blocked === null,
    resendBlockedReason: blocked,
  };
}

/**
 * The event key a resend is recorded under.
 *
 * Derived from the original delivery's own key, never minted fresh from a
 * clock: two staff pressing Re-send at the same moment on the same record
 * compute the same key, so the second is refused by the unique index and the
 * customer gets one copy. The attempt number is what makes a *deliberate*
 * second resend, made later after the first was seen to fail, a genuinely new
 * event rather than a silently swallowed one.
 */
export function resendEventKey(originalEventKey: string, attempt: number): string {
  const base = (originalEventKey || "unknown").slice(0, 180);
  return `resend:${base}:${Math.max(1, Math.trunc(attempt))}`;
}

/** True when this template may be re-sent at all. Re-exported so callers need one import. */
export { isResendableTemplate, maskRecipient };
export type { EmailTemplateKey };
