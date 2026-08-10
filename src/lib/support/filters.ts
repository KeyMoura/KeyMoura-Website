/**
 * The query model behind `/staff/support`.
 *
 * Pure and dependency-free, so the page, the API route and the tests read the
 * same definition — the pattern `orderFilters.ts`, `userDirectory.ts` and
 * `audit/query.ts` already follow, and for the reason those exist: a filter must
 * not mean one thing in the URL and another in the query.
 *
 * Every filter is an enum or a bounded value. Nothing here is interpolated into
 * SQL; the route maps these onto PostgREST calls against `staff_support_queue`.
 * A query parameter cannot become a way to ask the database a question the inbox
 * never offered.
 *
 * ## Everything runs in Postgres
 *
 * Search, filter, sort and page. There is deliberately no endpoint that returns
 * every conversation: a support inbox holds customers' words about their orders,
 * and shipping all of them to every staff browser so the browser can hide most
 * of them is both the slow answer and the unsafe one.
 */

import {
  SUPPORT_CATEGORIES,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  looksLikeSupportReference,
  normalizeSupportReference,
  type SupportCategory,
  type SupportPriority,
  type SupportStatus,
} from "./domain.ts";

// ---------------------------------------------------------------------------
// Vocabularies specific to the inbox
// ---------------------------------------------------------------------------

/**
 * The one-press views along the top of the inbox.
 *
 * These are not a second status vocabulary — each resolves to a filter over the
 * statuses and columns that already exist. `unassigned` and `mine` are the two
 * that are not statuses at all, and they are the two a staff member reaches for
 * most: "what has nobody picked up" and "what is mine".
 */
export const SUPPORT_VIEWS = [
  "needs_attention",
  "open",
  "waiting_on_staff",
  "waiting_on_customer",
  "unassigned",
  "mine",
  "high_priority",
  "resolved",
  "all",
] as const;

export type SupportView = (typeof SUPPORT_VIEWS)[number];

export const SUPPORT_VIEW_LABELS: Readonly<Record<SupportView, string>> = {
  needs_attention: "Needs attention",
  open: "Open",
  waiting_on_staff: "Waiting on staff",
  waiting_on_customer: "Waiting on customer",
  unassigned: "Unassigned",
  mine: "Assigned to me",
  high_priority: "High priority",
  resolved: "Resolved",
  all: "All",
};

/** What each view actually asks for, so the chip and the query cannot disagree. */
export const SUPPORT_VIEW_MEANING: Readonly<Record<SupportView, string>> = {
  needs_attention: "Open or waiting on staff — nobody has answered, or the customer came back.",
  open: "Nobody has replied yet.",
  waiting_on_staff: "The customer has replied and is waiting on us.",
  waiting_on_customer: "We have replied and are waiting on them.",
  unassigned: "Unresolved and nobody owns it.",
  mine: "Unresolved and assigned to you.",
  high_priority: "Unresolved, marked high or urgent.",
  resolved: "Resolved or closed.",
  all: "Everything, including closed.",
};

export type SupportSort = "attention" | "newest" | "oldest" | "recent_activity" | "priority";

export const SUPPORT_SORTS: readonly SupportSort[] = [
  "attention",
  "recent_activity",
  "newest",
  "oldest",
  "priority",
];

export const SUPPORT_SORT_LABELS: Readonly<Record<SupportSort, string>> = {
  attention: "Needs attention first",
  recent_activity: "Latest message",
  newest: "Newest",
  oldest: "Oldest",
  priority: "Priority",
};

/**
 * How a sort maps onto the view's columns, in order of application.
 *
 * `attention` is the default and is three keys, not one: unresolved before
 * resolved, then urgency, then the freshest customer activity. Sorting only by
 * "latest message" — the obvious choice — puts a resolved thread somebody
 * thanked you on above an unanswered question from this morning.
 *
 * Every list ends with `id` in the same direction. Two conversations created in
 * the same millisecond must not be able to swap places between page one and
 * page two, which is how a row gets shown twice and another never at all.
 */
export const SUPPORT_SORT_COLUMNS: Readonly<
  Record<SupportSort, readonly { column: string; ascending: boolean; nullsFirst: boolean }[]>
> = {
  attention: [
    { column: "is_unresolved", ascending: false, nullsFirst: false },
    { column: "priority_rank", ascending: true, nullsFirst: false },
    { column: "last_message_at", ascending: false, nullsFirst: false },
  ],
  recent_activity: [{ column: "last_message_at", ascending: false, nullsFirst: false }],
  newest: [{ column: "created_at", ascending: false, nullsFirst: false }],
  oldest: [{ column: "created_at", ascending: true, nullsFirst: false }],
  priority: [
    { column: "priority_rank", ascending: true, nullsFirst: false },
    { column: "last_message_at", ascending: false, nullsFirst: false },
  ],
};

export const DEFAULT_SUPPORT_PAGE_SIZE = 25;
export const MAX_SUPPORT_PAGE_SIZE = 100;
export const MAX_SUPPORT_SEARCH_LENGTH = 120;

// ---------------------------------------------------------------------------
// The filter shape
// ---------------------------------------------------------------------------

export type SupportFilters = {
  /** A SUP reference, a KM order number, a subject fragment, or a name/email. */
  search: string;
  view: SupportView;
  status: SupportStatus | null;
  category: SupportCategory | null;
  priority: SupportPriority | null;
  /** A staff user id, or the literal `"unassigned"`, or `"me"`. */
  assignee: string | null;
  /** A customer's user id — the link from the user workspace. */
  customerId: string | null;
  /** An order's uuid — the link from the order workspace. */
  orderId: string | null;
  /** ISO dates (YYYY-MM-DD), inclusive, against `created_at`. */
  createdFrom: string | null;
  createdTo: string | null;
  sort: SupportSort;
  page: number;
  pageSize: number;
};

export const SUPPORT_PARAM = {
  search: "q",
  view: "view",
  status: "status",
  category: "category",
  priority: "priority",
  assignee: "assignee",
  customerId: "customer",
  orderId: "order",
  createdFrom: "from",
  createdTo: "to",
  sort: "sort",
  page: "page",
  pageSize: "size",
} as const;

export const UNASSIGNED = "unassigned";
export const ASSIGNED_TO_ME = "me";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAILISH_PATTERN = /^[^\s@]+@[^\s@]+$/;
const ORDER_NUMBER_PATTERN = /^km-?\d{1,10}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function looksLikeEmail(value: string): boolean {
  return EMAILISH_PATTERN.test(String(value ?? "").trim());
}

export function looksLikeOrderNumber(value: string): boolean {
  return ORDER_NUMBER_PATTERN.test(String(value ?? "").trim());
}

export function normalizeOrderNumber(value: string): string | null {
  const raw = String(value ?? "").trim();
  if (!ORDER_NUMBER_PATTERN.test(raw)) return null;
  return `KM-${raw.replace(/^km-?/i, "").padStart(4, "0")}`;
}

/**
 * What a typed search string actually means.
 *
 * Four shapes, decided by what was typed rather than by a mode switch the staff
 * member has to find first: `SUP-0007` is a reference, `KM-0012` is an order,
 * an `@` is an address, and anything else is a subject or a name. Returned as a
 * tagged union so the route branches on a value rather than re-running the
 * regexes it just ran.
 */
export type SupportSearchKind =
  | { kind: "none" }
  | { kind: "reference"; reference: string }
  | { kind: "order_number"; orderNumber: string }
  | { kind: "id"; id: string }
  | { kind: "email"; email: string }
  | { kind: "text"; text: string };

export function classifySupportSearch(raw: string): SupportSearchKind {
  const value = String(raw ?? "").trim();
  if (!value) return { kind: "none" };
  if (looksLikeSupportReference(value)) {
    const reference = normalizeSupportReference(value);
    if (reference) return { kind: "reference", reference };
  }
  if (looksLikeOrderNumber(value)) {
    const orderNumber = normalizeOrderNumber(value);
    if (orderNumber) return { kind: "order_number", orderNumber };
  }
  if (isUuid(value)) return { kind: "id", id: value };
  if (looksLikeEmail(value)) return { kind: "email", email: value.toLowerCase() };
  return { kind: "text", text: value };
}

export function emptySupportFilters(): SupportFilters {
  return {
    search: "",
    view: "needs_attention",
    status: null,
    category: null,
    priority: null,
    assignee: null,
    customerId: null,
    orderId: null,
    createdFrom: null,
    createdTo: null,
    sort: "attention",
    page: 1,
    pageSize: DEFAULT_SUPPORT_PAGE_SIZE,
  };
}

function pickFrom<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function pickDate(value: string | null): string | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  return Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) ? value : null;
}

/**
 * Reads filters out of a URL, refusing anything not offered.
 *
 * An unrecognised sort, an unknown status or a malformed date becomes the
 * default rather than an error. A stale bookmark should show the inbox, not a
 * stack trace — and a filter value the route does not recognise must never fall
 * through into the query.
 */
export function parseSupportFilters(params: URLSearchParams): SupportFilters {
  const rawSize = Number(params.get(SUPPORT_PARAM.pageSize));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0
      ? Math.min(rawSize, MAX_SUPPORT_PAGE_SIZE)
      : DEFAULT_SUPPORT_PAGE_SIZE;

  const rawPage = Number(params.get(SUPPORT_PARAM.page));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawAssignee = (params.get(SUPPORT_PARAM.assignee) ?? "").trim();
  const assignee =
    rawAssignee === UNASSIGNED || rawAssignee === ASSIGNED_TO_ME || isUuid(rawAssignee)
      ? rawAssignee
      : null;

  const rawCustomer = (params.get(SUPPORT_PARAM.customerId) ?? "").trim();
  const rawOrder = (params.get(SUPPORT_PARAM.orderId) ?? "").trim();

  return {
    search: (params.get(SUPPORT_PARAM.search) ?? "").trim().slice(0, MAX_SUPPORT_SEARCH_LENGTH),
    view: pickFrom(params.get(SUPPORT_PARAM.view), SUPPORT_VIEWS) ?? "needs_attention",
    status: pickFrom(params.get(SUPPORT_PARAM.status), SUPPORT_STATUSES),
    category: pickFrom(params.get(SUPPORT_PARAM.category), SUPPORT_CATEGORIES),
    priority: pickFrom(params.get(SUPPORT_PARAM.priority), SUPPORT_PRIORITIES),
    assignee,
    customerId: isUuid(rawCustomer) ? rawCustomer : null,
    orderId: isUuid(rawOrder) ? rawOrder : null,
    createdFrom: pickDate(params.get(SUPPORT_PARAM.createdFrom)),
    createdTo: pickDate(params.get(SUPPORT_PARAM.createdTo)),
    sort: pickFrom(params.get(SUPPORT_PARAM.sort), SUPPORT_SORTS) ?? "attention",
    page,
    pageSize,
  };
}

/** Serializes filters back to a query string, omitting defaults. */
export function supportFiltersToQuery(filters: Partial<SupportFilters>): string {
  const params = new URLSearchParams();
  if (filters.search) params.set(SUPPORT_PARAM.search, filters.search);
  if (filters.view && filters.view !== "needs_attention") params.set(SUPPORT_PARAM.view, filters.view);
  if (filters.status) params.set(SUPPORT_PARAM.status, filters.status);
  if (filters.category) params.set(SUPPORT_PARAM.category, filters.category);
  if (filters.priority) params.set(SUPPORT_PARAM.priority, filters.priority);
  if (filters.assignee) params.set(SUPPORT_PARAM.assignee, filters.assignee);
  if (filters.customerId) params.set(SUPPORT_PARAM.customerId, filters.customerId);
  if (filters.orderId) params.set(SUPPORT_PARAM.orderId, filters.orderId);
  if (filters.createdFrom) params.set(SUPPORT_PARAM.createdFrom, filters.createdFrom);
  if (filters.createdTo) params.set(SUPPORT_PARAM.createdTo, filters.createdTo);
  if (filters.sort && filters.sort !== "attention") params.set(SUPPORT_PARAM.sort, filters.sort);
  if (filters.page && filters.page > 1) params.set(SUPPORT_PARAM.page, String(filters.page));
  if (filters.pageSize && filters.pageSize !== DEFAULT_SUPPORT_PAGE_SIZE) {
    params.set(SUPPORT_PARAM.pageSize, String(filters.pageSize));
  }
  return params.toString();
}

/** True when any filter beyond the default view, sorting and paging is set. */
export function hasActiveSupportFilters(filters: SupportFilters): boolean {
  return Boolean(
    filters.search ||
      filters.status ||
      filters.category ||
      filters.priority ||
      filters.assignee ||
      filters.customerId ||
      filters.orderId ||
      filters.createdFrom ||
      filters.createdTo ||
      filters.view !== "needs_attention"
  );
}

/**
 * A view, expressed as the constraints the route applies.
 *
 * Returned as data rather than applied here so this module stays free of the
 * Supabase client, and so a test can assert what a chip *means* without standing
 * up a database. `statuses` is an allow-list; `assigned` is a tri-state where
 * `null` means "do not constrain".
 */
export type SupportViewConstraint = {
  statuses: readonly SupportStatus[] | null;
  assigned: "unassigned" | "me" | null;
  minimumPriority: readonly SupportPriority[] | null;
};

export function constraintForView(view: SupportView): SupportViewConstraint {
  switch (view) {
    case "needs_attention":
      return { statuses: ["open", "waiting_on_staff"], assigned: null, minimumPriority: null };
    case "open":
      return { statuses: ["open"], assigned: null, minimumPriority: null };
    case "waiting_on_staff":
      return { statuses: ["waiting_on_staff"], assigned: null, minimumPriority: null };
    case "waiting_on_customer":
      return { statuses: ["waiting_on_customer"], assigned: null, minimumPriority: null };
    case "unassigned":
      return {
        statuses: ["open", "waiting_on_staff", "waiting_on_customer"],
        assigned: "unassigned",
        minimumPriority: null,
      };
    case "mine":
      return {
        statuses: ["open", "waiting_on_staff", "waiting_on_customer"],
        assigned: "me",
        minimumPriority: null,
      };
    case "high_priority":
      return {
        statuses: ["open", "waiting_on_staff", "waiting_on_customer"],
        assigned: null,
        minimumPriority: ["high", "urgent"],
      };
    case "resolved":
      return { statuses: ["resolved", "closed"], assigned: null, minimumPriority: null };
    case "all":
      return { statuses: null, assigned: null, minimumPriority: null };
  }
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * One inbox row, as the API returns it.
 *
 * Deliberately narrower than the view. The queue carries `requester_email` and
 * the customer's uuid because filtering and linking need them; a *list* does not
 * need a message body, and no body is ever sent to the inbox — a row shows what
 * the conversation is, not what it says.
 */
export type SupportInboxRow = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: SupportPriority;
  isGuest: boolean;
  requesterLabel: string;
  requesterEmail: string | null;
  customerId: string | null;
  relatedOrderId: string | null;
  relatedOrderNumber: string | null;
  assignedTo: string | null;
  assignedToLabel: string | null;
  createdAt: string;
  lastMessageAt: string;
  lastCustomerMessageAt: string | null;
  lastStaffMessageAt: string | null;
  messageCount: number;
  noteCount: number;
};
