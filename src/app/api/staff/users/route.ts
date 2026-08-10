import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  isUserUuid,
  looksLikeEmail,
  normalizeOrderNumber,
  parseUserFilters,
  USER_SORT_COLUMNS,
  type AccountStatus,
  type UserDirectoryRow,
} from "@/lib/staff/userDirectory";

/**
 * The staff user directory, read server-side.
 *
 * Searching, filtering, sorting and paging all happen in Postgres against
 * `staff_user_directory`. There is no endpoint here that returns every user:
 * the page it replaces selected all of them into the browser and filtered in
 * JavaScript, which ships every customer's record to every staff client
 * regardless of what the list shows, and stops working long before the table
 * gets big.
 *
 * Reading the directory is not itself audited. A read is not a mutation, and an
 * audit log that records its own inspection grows faster from being looked at
 * than from anything happening — the same call `/api/staff/audit` makes.
 */

export const runtime = "nodejs";

/**
 * Named columns, never `*`.
 *
 * The view carries `is_op`, `karma`, `auth_deleted` and `auth_banned` because
 * filtering needs them; none of them is a thing a directory listing has to send
 * to a browser. Every field that leaves the server is a field that has to stay
 * safe forever, so the list is short on purpose.
 */
const SELECT_COLUMNS =
  "id,username,display_name,avatar_url,email,email_confirmed,is_verified," +
  "role_key,role_name,role_rank,is_staff,account_status,providers," +
  "created_at,last_seen_at,last_sign_in_at," +
  "order_count,open_order_count,completed_order_count,net_spend_cents,last_order_at,open_production_count";

type DirectoryRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
  email_confirmed: boolean | null;
  is_verified: boolean | null;
  role_key: string | null;
  role_name: string | null;
  role_rank: number | null;
  is_staff: boolean | null;
  account_status: string | null;
  providers: string[] | null;
  created_at: string;
  last_seen_at: string | null;
  last_sign_in_at: string | null;
  order_count: number | null;
  open_order_count: number | null;
  completed_order_count: number | null;
  net_spend_cents: number | null;
  last_order_at: string | null;
  open_production_count: number | null;
};

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["users.view", "users.search"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const filters = parseUserFilters(url.searchParams);

  let query = routeServiceClient.from("staff_user_directory").select(SELECT_COLUMNS, { count: "exact" });

  // --- search ---------------------------------------------------------------
  //
  // Four shapes, decided by what was typed rather than by a mode switch the
  // staff member has to find: a uuid is an id, `KM-0012` is an order number, an
  // `@` is an address, anything else is a name.
  let searchNote: string | null = null;

  if (filters.search) {
    /*
     * `filters.search` is used in the branches below rather than a narrowed
     * local. `isUserUuid` is declared `(v: unknown) => v is string`, so calling
     * it on a value TypeScript already knows is a string narrows the *false*
     * branch to `never` — string minus string. Reading the field again sidesteps
     * a narrowing that is an artefact of the guard's signature, not a fact about
     * the value.
     */
    if (isUserUuid(filters.search)) {
      query = query.eq("id", filters.search);
    } else {
      const orderNumber = normalizeOrderNumber(filters.search);

      if (orderNumber) {
        /*
         * An order number resolves to its owner, not to a text match.
         *
         * A guest order has no owner, and this is the one place that could
         * quietly imply otherwise — returning the account whose email matches
         * would be exactly the false claim phase 17 forbids. So a guest order
         * number returns no users and says why.
         */
        const { data: order } = await routeServiceClient
          .from("orders")
          .select("customer_id")
          .eq("order_number", orderNumber)
          .maybeSingle<{ customer_id: string | null }>();

        if (!order) {
          searchNote = `No order ${orderNumber} exists.`;
          return NextResponse.json({ users: [], total: 0, page: 1, pageSize: filters.pageSize, hasMore: false, searchNote });
        }
        if (!order.customer_id) {
          searchNote = `${orderNumber} is a guest order and is not owned by any account.`;
          return NextResponse.json({ users: [], total: 0, page: 1, pageSize: filters.pageSize, hasMore: false, searchNote });
        }
        query = query.eq("id", order.customer_id);
        searchNote = `Showing the account that owns ${orderNumber}.`;
      } else {
        // Escaped so a comma or parenthesis in the search box cannot break out
        // of the `or` expression and become extra filter syntax.
        const safe = filters.search.replace(/[(),*\\]/g, " ").trim();
        if (safe) {
          const pattern = `%${safe}%`;
          // An address is matched against `email` alone. Searching a full
          // address across name columns too would return people whose display
          // name merely contains it, which reads as "these accounts share an
          // address" and is not what the row means.
          const parts = looksLikeEmail(safe)
            ? [`email.ilike.${pattern}`]
            : [`display_name.ilike.${pattern}`, `username.ilike.${pattern}`, `email.ilike.${pattern}`];
          query = query.or(parts.join(","));
        }
      }
    }
  }

  // --- filters --------------------------------------------------------------
  if (filters.role) query = query.eq("role_key", filters.role);
  if (filters.kind) query = query.eq("is_staff", filters.kind === "staff");
  if (filters.status) query = query.eq("account_status", filters.status);
  if (filters.provider) query = query.contains("providers", [filters.provider]);

  if (filters.orders === "has_orders") query = query.gt("order_count", 0);
  if (filters.orders === "no_orders") query = query.eq("order_count", 0);

  if (filters.joinedFrom) query = query.gte("created_at", `${filters.joinedFrom}T00:00:00.000Z`);
  if (filters.joinedTo) query = query.lte("created_at", `${filters.joinedTo}T23:59:59.999Z`);

  if (filters.activeWithinDays) {
    const since = new Date(Date.now() - filters.activeWithinDays * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte("last_seen_at", since);
  }

  // --- sort and page --------------------------------------------------------
  const sort = USER_SORT_COLUMNS[filters.sort];
  query = query.order(sort.column, { ascending: sort.ascending, nullsFirst: sort.nullsFirst });
  // `id` breaks ties in the same direction, so two users created in the same
  // millisecond cannot swap places between page one and page two.
  query = query.order("id", { ascending: sort.ascending });

  const offset = (filters.page - 1) * filters.pageSize;
  query = query.range(offset, offset + filters.pageSize - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error("[staff/users] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load the user directory." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as DirectoryRow[];
  const total = typeof count === "number" ? count : rows.length;

  return NextResponse.json({
    users: rows.map(toView),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    hasMore: offset + rows.length < total,
    searchNote,
  });
}

function toView(row: DirectoryRow): UserDirectoryRow {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    email: row.email,
    emailConfirmed: row.email_confirmed === true,
    roleKey: row.role_key ?? "member",
    roleName: row.role_name ?? "Member",
    roleRank: row.role_rank ?? 0,
    isStaff: row.is_staff === true,
    isVerified: row.is_verified === true,
    accountStatus: (row.account_status ?? "active") as AccountStatus,
    providers: Array.isArray(row.providers) ? row.providers : [],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastSignInAt: row.last_sign_in_at,
    orderCount: row.order_count ?? 0,
    openOrderCount: row.open_order_count ?? 0,
    completedOrderCount: row.completed_order_count ?? 0,
    netSpendCents: row.net_spend_cents ?? 0,
    lastOrderAt: row.last_order_at,
    openProductionCount: row.open_production_count ?? 0,
  };
}
