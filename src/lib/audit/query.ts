/**
 * The audit log's query model.
 *
 * Pure and dependency-free — the API route, the page and the tests all read the
 * same definition, so a filter cannot mean one thing in the URL and another in
 * the query. This mirrors `src/lib/staff/orderFilters.ts`, and for the same
 * reason: a filter parameter must never become a way to ask the database a
 * question the UI did not offer.
 *
 * Every filter is an enum or a bounded value. Nothing here is interpolated into
 * SQL; the route maps these onto PostgREST calls.
 */

import { AUDIT_AREAS, type AuditArea } from "./actions.ts";

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_MAX_PAGE_SIZE = 100;

export type AuditFilters = {
  /** Free text, matched against the entity label, summary and actor label. */
  search: string;
  /** Actor user id, or "system" for everything not done by a person. */
  actor: string | null;
  area: AuditArea | null;
  action: string | null;
  /** ISO date (YYYY-MM-DD), inclusive. */
  from: string | null;
  /** ISO date (YYYY-MM-DD), inclusive — the route widens it to end-of-day. */
  to: string | null;
  orderId: string | null;
  productionJobId: string | null;
  productId: string | null;
  pageSize: number;
  /**
   * Keyset cursor: the `occurred_at` of the last row on the previous page.
   * Offset pagination over a table that grows at the head shows duplicates;
   * a cursor does not.
   */
  cursor: string | null;
};

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  search: "",
  actor: null,
  area: null,
  action: null,
  from: null,
  to: null,
  orderId: null,
  productionJobId: null,
  productId: null,
  pageSize: AUDIT_PAGE_SIZE,
  cursor: null,
};

export const AUDIT_PARAM = {
  search: "q",
  actor: "actor",
  area: "area",
  action: "action",
  from: "from",
  to: "to",
  orderId: "order",
  productionJobId: "job",
  productId: "product",
  pageSize: "size",
  cursor: "cursor",
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function pickUuid(value: string | null): string | null {
  return isUuid(value) ? value : null;
}

function pickDate(value: string | null): string | null {
  if (!value || !DATE_PATTERN.test(value)) return null;
  return Number.isFinite(new Date(`${value}T00:00:00Z`).getTime()) ? value : null;
}

/**
 * Reads filters out of a URL, refusing anything not offered.
 *
 * An unrecognised area or a malformed date becomes `null` rather than an error:
 * a stale bookmark should show the unfiltered log, not a stack trace.
 */
export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const area = params.get(AUDIT_PARAM.area);
  const rawSize = Number(params.get(AUDIT_PARAM.pageSize));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, AUDIT_MAX_PAGE_SIZE) : AUDIT_PAGE_SIZE;

  const actor = params.get(AUDIT_PARAM.actor);

  return {
    search: (params.get(AUDIT_PARAM.search) ?? "").trim().slice(0, 120),
    // "system" is a real filter value, not a user id — it selects everything
    // with no person behind it.
    actor: actor === "system" ? "system" : pickUuid(actor),
    area: (AUDIT_AREAS as readonly string[]).includes(String(area)) ? (area as AuditArea) : null,
    action: (params.get(AUDIT_PARAM.action) ?? "").trim().slice(0, 80) || null,
    from: pickDate(params.get(AUDIT_PARAM.from)),
    to: pickDate(params.get(AUDIT_PARAM.to)),
    orderId: pickUuid(params.get(AUDIT_PARAM.orderId)),
    productionJobId: pickUuid(params.get(AUDIT_PARAM.productionJobId)),
    productId: pickUuid(params.get(AUDIT_PARAM.productId)),
    pageSize,
    cursor: params.get(AUDIT_PARAM.cursor),
  };
}

/** Serializes filters back to a query string, omitting defaults. */
export function auditFiltersToQuery(filters: Partial<AuditFilters>): string {
  const params = new URLSearchParams();
  if (filters.search) params.set(AUDIT_PARAM.search, filters.search);
  if (filters.actor) params.set(AUDIT_PARAM.actor, filters.actor);
  if (filters.area) params.set(AUDIT_PARAM.area, filters.area);
  if (filters.action) params.set(AUDIT_PARAM.action, filters.action);
  if (filters.from) params.set(AUDIT_PARAM.from, filters.from);
  if (filters.to) params.set(AUDIT_PARAM.to, filters.to);
  if (filters.orderId) params.set(AUDIT_PARAM.orderId, filters.orderId);
  if (filters.productionJobId) params.set(AUDIT_PARAM.productionJobId, filters.productionJobId);
  if (filters.productId) params.set(AUDIT_PARAM.productId, filters.productId);
  if (filters.pageSize && filters.pageSize !== AUDIT_PAGE_SIZE) {
    params.set(AUDIT_PARAM.pageSize, String(filters.pageSize));
  }
  if (filters.cursor) params.set(AUDIT_PARAM.cursor, filters.cursor);
  return params.toString();
}

/** True when any filter beyond paging is set. */
export function hasActiveFilters(filters: AuditFilters): boolean {
  return Boolean(
    filters.search ||
      filters.actor ||
      filters.area ||
      filters.action ||
      filters.from ||
      filters.to ||
      filters.orderId ||
      filters.productionJobId ||
      filters.productId
  );
}
