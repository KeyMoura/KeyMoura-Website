/**
 * The load state of one independent panel of data.
 *
 * ## Why this exists
 *
 * Pass 9 fixed the dashboard and the fulfillment queue for a defect it named
 * precisely: a refused query rendered as a confident zero. It fixed them with
 * hand-written `ordersError`/`productsError` string pairs and `ordersUsable`
 * booleans, and the same defect survived untouched on `/staff/orders` — because
 * the *pattern* was copied by hand and the copy was never made.
 *
 * The fix that generalizes is not another careful `if`. It is making the wrong
 * thing unrepresentable: **there is no way to read rows out of this type without
 * first proving the load succeeded.** `data` exists only on the `ready` variant,
 * so `state.data.length` does not compile on a state that might have failed.
 * A count is therefore structurally unable to come from a failure.
 *
 * ## The four states are distinct on purpose
 *
 * - `loading` — the query is in flight. Not empty, not zero.
 * - `error` — the query failed. The answer is *unknown*, which is not `0`.
 * - `ready` with rows — real data.
 * - `ready` with no rows — a **successful** query that matched nothing. This is
 *   the only state in which "nothing needs attention" is a true sentence.
 *
 * `idle` covers the fourth real case the staff area has: a panel the viewer
 * lacks permission to load at all. Rendering that as `0` claims there is
 * nothing there, when the truth is that this viewer may not be told.
 *
 * Pure and dependency-free — no React, no `next/*` — so the rules are unit
 * testable rather than only observable by rendering a page.
 */

/** A failure classified for display. The raw provider message never reaches a UI. */
export type LoadFailure = {
  /**
   * A sentence a staff member can act on. Never the raw Postgres or PostgREST
   * message: those carry column names, constraint names and occasionally row
   * values, and this string is rendered into a page.
   */
  message: string;
  /** Coarse cause, for choosing whether to offer a retry. */
  kind: "permission" | "network" | "server" | "unknown";
  /**
   * A short opaque token echoed by the server so a staff member can quote it and
   * a developer can find the matching server log line. Carries no data itself.
   */
  reference?: string;
};

export type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; failure: LoadFailure }
  | { status: "ready"; data: T };

// Generic, so a caller can write `loading<Payload>()` and keep one state
// variable across all four cases instead of widening it to `unknown`.
export const idle = <T = never>(): LoadState<T> => ({ status: "idle" });
export const loading = <T = never>(): LoadState<T> => ({ status: "loading" });
export const ready = <T>(data: T): LoadState<T> => ({ status: "ready", data });
export const failed = <T = never>(failure: LoadFailure): LoadState<T> => ({ status: "error", failure });

/**
 * Classify a Supabase/PostgREST error into something safe to render.
 *
 * The raw `error.message` is deliberately **dropped**, not passed through. It is
 * written for a developer reading a log, it names schema objects, and on a
 * constraint violation it can quote the offending value — which on this schema
 * can be a customer's address or a private note. `/staff/orders` previously
 * rendered `orderResult.error.message` straight into the page.
 */
export function classifySupabaseError(error: { code?: string | null; message?: string | null } | null | undefined): LoadFailure {
  const code = String(error?.code ?? "");
  // 42501 insufficient_privilege, PGRST301 JWT expired, 401/403 from PostgREST.
  if (code === "42501" || code === "PGRST301" || code === "401" || code === "403") {
    return { kind: "permission", message: "You do not have access to this data, or your session has expired. Sign in again and retry." };
  }
  // 42P01 undefined_table, 42703 undefined_column — a deployment/schema fault.
  if (code === "42P01" || code === "42703" || code.startsWith("42")) {
    return { kind: "server", message: "This data could not be read because of a server fault. It has been logged; the number shown elsewhere on this page is unaffected." };
  }
  return { kind: "unknown", message: "This data could not be loaded. Retry, and if it keeps failing report it with the time." };
}

/** Build a `LoadState` from a Supabase result, without the caller having to remember to check `error`. */
export function fromSupabase<T>(result: { data: T | null; error: { code?: string | null; message?: string | null } | null }): LoadState<T[]> {
  if (result.error) return failed(classifySupabaseError(result.error));
  return ready((result.data ?? []) as unknown as T[]);
}

export const isReady = <T>(state: LoadState<T>): state is { status: "ready"; data: T } => state.status === "ready";
export const isFailed = <T>(state: LoadState<T>): state is { status: "error"; failure: LoadFailure } => state.status === "error";
export const isPending = <T>(state: LoadState<T>): boolean => state.status === "loading" || state.status === "idle";

/**
 * The rows, or `null` when there are none to be had.
 *
 * Deliberately **not** `?? []`. `data ?? []` is the exact expression that turned
 * every failed load in this codebase into a zero; returning `null` forces the
 * caller to choose a state instead of falling into an empty array.
 */
export function rowsOrNull<T>(state: LoadState<T[]>): T[] | null {
  return isReady(state) ? state.data : null;
}

/**
 * A count that is `null` when it is not known.
 *
 * The whole point: a badge renders `null` as *nothing*, not as `0`. "Needs
 * action (0)" beside a red banner is the defect this file exists to remove.
 */
export function countOrNull<T>(state: LoadState<T[]>): number | null {
  return isReady(state) ? state.data.length : null;
}

/**
 * Whether a "nothing to do" sentence is *true*.
 *
 * Only a successful load that returned no rows earns it. Loading has not
 * finished, a failure does not know, and an unpermitted panel was never told.
 */
export function isTrulyEmpty<T>(state: LoadState<T[]>): boolean {
  return isReady(state) && state.data.length === 0;
}

/**
 * Derive a value from several panels, yielding `null` unless **all** succeeded.
 *
 * A summary computed from a partly failed set of loads is the subtlest form of
 * the same lie: every input looks like a number, and the total is wrong with no
 * indication that it is. `buildDashboardSummary([])` will happily report $0.
 */
export function allReady<A, B>(a: LoadState<A>, b: LoadState<B>): [A, B] | null;
export function allReady<A, B, C>(a: LoadState<A>, b: LoadState<B>, c: LoadState<C>): [A, B, C] | null;
export function allReady(...states: LoadState<unknown>[]): unknown[] | null {
  if (!states.every(isReady)) return null;
  return states.map((state) => (state as { status: "ready"; data: unknown }).data);
}

/** Every distinct failure across a set of panels, for one summary banner. */
export function failuresOf(states: Readonly<Record<string, LoadState<unknown>>>): { panel: string; failure: LoadFailure }[] {
  return Object.entries(states)
    .filter(([, state]) => isFailed(state))
    .map(([panel, state]) => ({ panel, failure: (state as { status: "error"; failure: LoadFailure }).failure }));
}
