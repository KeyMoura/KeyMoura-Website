/**
 * The query model behind `/staff/users`.
 *
 * Pure and dependency-free — no React, no `next/*`, no Supabase — so the page,
 * the API route and the tests read the **same** definition. This mirrors
 * `orderFilters.ts` and `audit/query.ts`, and for the same reason those exist: a
 * filter must not mean one thing in the URL and another in the query.
 *
 * Every filter is an enum or a bounded value. Nothing here is interpolated into
 * SQL; the route maps these onto PostgREST calls against `staff_user_directory`.
 * A filter parameter cannot become a way to ask the database a question the UI
 * never offered.
 *
 * ## What "spend" means, in one place
 *
 * `paid_cents` is money actually received — `orders.amount_paid_cents`, summed
 * over **account-owned orders only**. An unpaid quote, an abandoned checkout and
 * an order cancelled before payment all carry zero there, so none of them needs
 * excluding by name. `netSpendCents` subtracts refunds and is floored at zero.
 *
 * A guest order is never included, however well its email matches. That rule is
 * enforced in the view (`customer_id` equality and nothing else) and restated
 * here because this is the file somebody reads when they wonder why a total
 * looks low.
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Account status, derived rather than stored.
 *
 * KeyMoura already decides this in `user_bans` and `user_restrictions`. A status
 * column would be a second answer to a question those tables already answer, and
 * two answers drift. The view computes it; this list is what the filter offers.
 */
export const ACCOUNT_STATUSES = ["active", "restricted", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABELS: Readonly<Record<AccountStatus, string>> = {
  active: "Active",
  restricted: "Restricted",
  suspended: "Suspended",
};

/**
 * What each status actually means for the person, stated so the UI cannot
 * invent its own wording and so nobody has to read the moderation routes to
 * find out what a chip implies.
 *
 * Note what is *absent*: none of these stops transactional order email. A
 * customer who paid is told when their order ships regardless of standing —
 * suspending an account is not a licence to stop honouring a paid order.
 */
export const ACCOUNT_STATUS_MEANING: Readonly<Record<AccountStatus, string>> = {
  active: "Full access. Can sign in, browse, order and post.",
  restricted: "Signed in and can see paid orders, but one or more areas are withheld.",
  suspended: "Cannot sign in. Existing paid orders and their email updates are unaffected.",
};

export const USER_KINDS = ["staff", "customer"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** Whether the account has ever placed an account-owned order. */
export const ORDER_PRESENCE = ["has_orders", "no_orders"] as const;
export type OrderPresence = (typeof ORDER_PRESENCE)[number];

/** Provider names as `auth.identities` records them. */
export const LOGIN_PROVIDERS = ["email", "google", "facebook"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export const USER_SORTS = [
  "newest",
  "oldest",
  "name",
  "orders_desc",
  "spend_desc",
  "recent_activity",
] as const;
export type UserSort = (typeof USER_SORTS)[number];

export const USER_SORT_LABELS: Readonly<Record<UserSort, string>> = {
  newest: "Newest",
  oldest: "Oldest",
  name: "Name",
  orders_desc: "Most orders",
  spend_desc: "Highest spend",
  recent_activity: "Recent activity",
};

/**
 * How each sort maps onto the view's columns.
 *
 * Held here rather than in the route so the label and the ordering cannot
 * disagree, and so a test can assert every sort names a column the view has.
 * `nullsFirst: false` matters on `last_seen_at` and `last_order_at`: a user who
 * has never signed in must sort to the bottom of "recent activity", not the top.
 */
export const USER_SORT_COLUMNS: Readonly<
  Record<UserSort, { column: string; ascending: boolean; nullsFirst: boolean }>
> = {
  newest: { column: "created_at", ascending: false, nullsFirst: false },
  oldest: { column: "created_at", ascending: true, nullsFirst: false },
  name: { column: "display_name", ascending: true, nullsFirst: false },
  orders_desc: { column: "order_count", ascending: false, nullsFirst: false },
  spend_desc: { column: "net_spend_cents", ascending: false, nullsFirst: false },
  recent_activity: { column: "last_seen_at", ascending: false, nullsFirst: false },
};

export const DEFAULT_USER_PAGE_SIZE = 25;
export const MAX_USER_PAGE_SIZE = 100;
export const MAX_USER_SEARCH_LENGTH = 120;

// ---------------------------------------------------------------------------
// The filter shape
// ---------------------------------------------------------------------------

export type UserFilters = {
  /** Display name, username, email, or a user UUID. */
  search: string;
  role: string | null;
  kind: UserKind | null;
  status: AccountStatus | null;
  orders: OrderPresence | null;
  provider: LoginProvider | null;
  /** ISO date (YYYY-MM-DD), inclusive, against `created_at`. */
  joinedFrom: string | null;
  joinedTo: string | null;
  /** Seen within this many days. Bounded to the offered options. */
  activeWithinDays: number | null;
  sort: UserSort;
  page: number;
  pageSize: number;
};

export const ACTIVE_WITHIN_OPTIONS = [1, 7, 30, 90] as const;

export function emptyUserFilters(): UserFilters {
  return {
    search: "",
    role: null,
    kind: null,
    status: null,
    orders: null,
    provider: null,
    joinedFrom: null,
    joinedTo: null,
    activeWithinDays: null,
    sort: "newest",
    page: 1,
    pageSize: DEFAULT_USER_PAGE_SIZE,
  };
}

export const USER_PARAM = {
  search: "q",
  role: "role",
  kind: "kind",
  status: "status",
  orders: "orders",
  provider: "provider",
  joinedFrom: "from",
  joinedTo: "to",
  activeWithinDays: "active",
  sort: "sort",
  page: "page",
  pageSize: "size",
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Deliberately loose: this decides "search this as an address", not validity. */
const EMAILISH_PATTERN = /^[^\s@]+@[^\s@]+$/;
/** KM-0012 and friends, in either case, with or without the dash. */
const ORDER_NUMBER_PATTERN = /^km-?\d{1,10}$/i;

/**
 * Deliberately a plain `boolean`, not a `value is string` type predicate.
 *
 * As a predicate over `unknown`, calling it on a value TypeScript already knows
 * is a string narrows the **false** branch to `never` — `string` minus `string`
 * — so the `else` of `if (isUserUuid(search))` becomes unusable. Every caller
 * here passes a string and wants the answer, not the narrowing.
 */
export function isUserUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function looksLikeEmail(value: string): boolean {
  return EMAILISH_PATTERN.test(value.trim());
}

export function looksLikeOrderNumber(value: string): boolean {
  return ORDER_NUMBER_PATTERN.test(value.trim());
}

/**
 * Normalizes `km12`, `KM-12` and `km-0012` to the stored `KM-0012`.
 *
 * Staff type order numbers from memory and from printed paperwork, and the two
 * do not agree about the dash or the leading zeros. Returning `null` for
 * anything that is not an order number keeps the caller's branch honest.
 */
export function normalizeOrderNumber(value: string): string | null {
  const raw = value.trim();
  if (!ORDER_NUMBER_PATTERN.test(raw)) return null;
  const digits = raw.replace(/^km-?/i, "");
  return `KM-${digits.padStart(4, "0")}`;
}

function pickDate(value: string | null): string | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  return Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) ? value : null;
}

function pickFrom<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Reads filters out of a URL, refusing anything not offered.
 *
 * An unrecognised sort or a malformed date becomes the default rather than an
 * error: a stale bookmark should show the directory, not a stack trace.
 */
export function parseUserFilters(params: URLSearchParams): UserFilters {
  const rawSize = Number(params.get(USER_PARAM.pageSize));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_USER_PAGE_SIZE) : DEFAULT_USER_PAGE_SIZE;

  const rawPage = Number(params.get(USER_PARAM.page));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawActive = Number(params.get(USER_PARAM.activeWithinDays));
  const activeWithinDays = (ACTIVE_WITHIN_OPTIONS as readonly number[]).includes(rawActive) ? rawActive : null;

  // Role is free-form because roles are user-created rows in `public.roles`, not
  // a fixed enum. It is bounded and lower-cased here, and the route matches it
  // with `eq` against `role_key` — never string-built into a query.
  const rawRole = (params.get(USER_PARAM.role) ?? "").trim().toLowerCase().slice(0, 40);

  return {
    search: (params.get(USER_PARAM.search) ?? "").trim().slice(0, MAX_USER_SEARCH_LENGTH),
    role: rawRole || null,
    kind: pickFrom(params.get(USER_PARAM.kind), USER_KINDS),
    status: pickFrom(params.get(USER_PARAM.status), ACCOUNT_STATUSES),
    orders: pickFrom(params.get(USER_PARAM.orders), ORDER_PRESENCE),
    provider: pickFrom(params.get(USER_PARAM.provider), LOGIN_PROVIDERS),
    joinedFrom: pickDate(params.get(USER_PARAM.joinedFrom)),
    joinedTo: pickDate(params.get(USER_PARAM.joinedTo)),
    activeWithinDays,
    sort: pickFrom(params.get(USER_PARAM.sort), USER_SORTS) ?? "newest",
    page,
    pageSize,
  };
}

/** Serializes filters back to a query string, omitting defaults. */
export function userFiltersToQuery(filters: Partial<UserFilters>): string {
  const params = new URLSearchParams();
  if (filters.search) params.set(USER_PARAM.search, filters.search);
  if (filters.role) params.set(USER_PARAM.role, filters.role);
  if (filters.kind) params.set(USER_PARAM.kind, filters.kind);
  if (filters.status) params.set(USER_PARAM.status, filters.status);
  if (filters.orders) params.set(USER_PARAM.orders, filters.orders);
  if (filters.provider) params.set(USER_PARAM.provider, filters.provider);
  if (filters.joinedFrom) params.set(USER_PARAM.joinedFrom, filters.joinedFrom);
  if (filters.joinedTo) params.set(USER_PARAM.joinedTo, filters.joinedTo);
  if (filters.activeWithinDays) params.set(USER_PARAM.activeWithinDays, String(filters.activeWithinDays));
  if (filters.sort && filters.sort !== "newest") params.set(USER_PARAM.sort, filters.sort);
  if (filters.page && filters.page > 1) params.set(USER_PARAM.page, String(filters.page));
  if (filters.pageSize && filters.pageSize !== DEFAULT_USER_PAGE_SIZE) {
    params.set(USER_PARAM.pageSize, String(filters.pageSize));
  }
  return params.toString();
}

/** True when any filter beyond sorting and paging is set. */
export function hasActiveUserFilters(filters: UserFilters): boolean {
  return Boolean(
    filters.search ||
      filters.role ||
      filters.kind ||
      filters.status ||
      filters.orders ||
      filters.provider ||
      filters.joinedFrom ||
      filters.joinedTo ||
      filters.activeWithinDays
  );
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * One directory row, as the API returns it.
 *
 * Deliberately narrower than the view. `is_op`, `karma` and `auth_deleted` are
 * columns the view carries for filtering and are not sent to the browser: a
 * directory listing does not need them, and every field that leaves the server
 * is a field that has to stay safe forever.
 */
export type UserDirectoryRow = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  emailConfirmed: boolean;
  roleKey: string;
  roleName: string;
  roleRank: number;
  isStaff: boolean;
  isVerified: boolean;
  accountStatus: AccountStatus;
  providers: string[];
  createdAt: string;
  lastSeenAt: string | null;
  lastSignInAt: string | null;
  orderCount: number;
  openOrderCount: number;
  completedOrderCount: number;
  netSpendCents: number;
  lastOrderAt: string | null;
  openProductionCount: number;
};

/** What the row shows when there is no display name and no username. */
export function userDisplayLabel(row: {
  displayName?: string | null;
  username?: string | null;
  email?: string | null;
  id: string;
}): string {
  const name = row.displayName?.trim();
  if (name) return name;
  const handle = row.username?.trim();
  if (handle) return handle;
  const email = row.email?.trim();
  if (email) return email;
  return `User ${row.id.slice(0, 8)}`;
}

/** The letter on the fallback avatar. */
export function userInitial(row: Parameters<typeof userDisplayLabel>[0]): string {
  return (userDisplayLabel(row).trim()[0] ?? "U").toUpperCase();
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type UserMetrics = {
  orderCount: number;
  completedOrderCount: number;
  openOrderCount: number;
  cancelledOrderCount: number;
  paidOrderCount: number;
  paidCents: number;
  refundedCents: number;
  netSpendCents: number;
  averageOrderValueCents: number | null;
  lastOrderAt: string | null;
  openProductionCount: number;
};

/**
 * Average order value, over **paid** orders only.
 *
 * Dividing lifetime spend by every order would count a quote nobody accepted as
 * a zero-value sale and drag the average down for no reason a person would
 * recognise. `null` rather than `0` when nothing has been paid, because "no
 * average yet" and "an average of nothing" are different claims and a `0` on
 * screen reads as the second.
 */
export function averageOrderValueCents(netSpendCents: number, paidOrderCount: number): number | null {
  if (paidOrderCount <= 0) return null;
  return Math.round(netSpendCents / paidOrderCount);
}

/** `1395` → `$13.95`. Cents in, never floats. */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const value = `$${(abs / 100).toFixed(2)}`;
  return negative ? `-${value}` : value;
}
