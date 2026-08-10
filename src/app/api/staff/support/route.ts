import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  ASSIGNED_TO_ME,
  UNASSIGNED,
  classifySupportSearch,
  constraintForView,
  parseSupportFilters,
  SUPPORT_SORT_COLUMNS,
  type SupportInboxRow,
} from "@/lib/support/filters";
import type { SupportCategory, SupportPriority, SupportStatus } from "@/lib/support/domain";

/**
 * The staff support inbox, read server-side.
 *
 * Searching, filtering, sorting and paging all happen in Postgres against
 * `staff_support_queue`. There is no endpoint here that returns every
 * conversation: the alternative ships every customer's correspondence to every
 * staff browser so the browser can hide most of it, which is both the slow
 * answer and the unsafe one.
 *
 * Reading the inbox is not audited. A read is not a mutation, and an audit log
 * that records its own inspection grows faster from being looked at than from
 * anything happening — the same call `/api/staff/audit` and `/api/staff/users`
 * make.
 */

export const runtime = "nodejs";

/**
 * Named columns, never `*`.
 *
 * No message body appears here, and none is in the view either. A list shows
 * what a conversation *is*, not what it says.
 */
const SELECT_COLUMNS =
  "id,reference,subject,category,status,priority,is_guest,requester_label,requester_email," +
  "customer_id,customer_display_name,customer_username,related_order_id,related_order_number," +
  "assigned_to,assigned_to_label,created_at,last_message_at,last_customer_message_at," +
  "last_staff_message_at,message_count,note_count";

type QueueRow = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: SupportPriority;
  is_guest: boolean;
  requester_label: string;
  requester_email: string | null;
  customer_id: string | null;
  customer_display_name: string | null;
  customer_username: string | null;
  related_order_id: string | null;
  related_order_number: string | null;
  assigned_to: string | null;
  assigned_to_label: string | null;
  created_at: string;
  last_message_at: string;
  last_customer_message_at: string | null;
  last_staff_message_at: string | null;
  message_count: number | null;
  note_count: number | null;
};

const empty = (pageSize: number, searchNote: string | null) =>
  NextResponse.json({ conversations: [], total: 0, page: 1, pageSize, hasMore: false, searchNote, counts: null });

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "support.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const filters = parseSupportFilters(url.searchParams);

  let query = routeServiceClient.from("staff_support_queue").select(SELECT_COLUMNS, { count: "exact" });
  let searchNote: string | null = null;

  // --- search ---------------------------------------------------------------
  //
  // Four shapes, decided by what was typed rather than by a mode switch the
  // staff member has to find first.
  const search = classifySupportSearch(filters.search);
  switch (search.kind) {
    case "reference":
      query = query.eq("reference", search.reference);
      break;
    case "order_number": {
      // An order number resolves to its order, then to the conversations linked
      // to it. A text match on `related_order_number` would work too, but going
      // through the order means a number that exists with no conversations says
      // so, and a number that does not exist says *that* — two different facts
      // that an empty list would conflate.
      const { data: order } = await routeServiceClient
        .from("orders")
        .select("id")
        .eq("order_number", search.orderNumber)
        .maybeSingle<{ id: string }>();
      if (!order) return empty(filters.pageSize, `No order ${search.orderNumber} exists.`);
      query = query.eq("related_order_id", order.id);
      searchNote = `Showing conversations linked to ${search.orderNumber}.`;
      break;
    }
    case "id":
      // A uuid is either a conversation or the customer who owns one.
      query = query.or(`id.eq.${search.id},customer_id.eq.${search.id}`);
      break;
    case "email":
      query = query.ilike("requester_email", `%${search.email.replace(/[(),*\\]/g, " ").trim()}%`);
      break;
    case "text": {
      // Escaped so a comma or parenthesis in the search box cannot break out of
      // the `or` expression and become extra filter syntax.
      const safe = search.text.replace(/[(),*\\]/g, " ").trim();
      if (safe) {
        const pattern = `%${safe}%`;
        query = query.or(
          [
            `subject.ilike.${pattern}`,
            `requester_label.ilike.${pattern}`,
            `customer_display_name.ilike.${pattern}`,
            `requester_email.ilike.${pattern}`,
          ].join(",")
        );
      }
      break;
    }
    case "none":
      break;
  }

  // --- the view chip --------------------------------------------------------
  const constraint = constraintForView(filters.view);
  if (constraint.statuses) query = query.in("status", [...constraint.statuses]);
  if (constraint.minimumPriority) query = query.in("priority", [...constraint.minimumPriority]);
  if (constraint.assigned === "unassigned") query = query.is("assigned_to", null);
  if (constraint.assigned === "me") query = query.eq("assigned_to", actor.userId);

  // --- explicit filters, which narrow the view rather than replace it -------
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.customerId) query = query.eq("customer_id", filters.customerId);
  if (filters.orderId) query = query.eq("related_order_id", filters.orderId);

  if (filters.assignee === UNASSIGNED) query = query.is("assigned_to", null);
  else if (filters.assignee === ASSIGNED_TO_ME) query = query.eq("assigned_to", actor.userId);
  else if (filters.assignee) query = query.eq("assigned_to", filters.assignee);

  if (filters.createdFrom) query = query.gte("created_at", `${filters.createdFrom}T00:00:00.000Z`);
  if (filters.createdTo) query = query.lte("created_at", `${filters.createdTo}T23:59:59.999Z`);

  // --- sort and page --------------------------------------------------------
  for (const key of SUPPORT_SORT_COLUMNS[filters.sort]) {
    query = query.order(key.column, { ascending: key.ascending, nullsFirst: key.nullsFirst });
  }
  // Every list ends on `id`, so two conversations touched in the same
  // millisecond cannot swap places between page one and page two — which is how
  // one row gets shown twice and another never at all.
  query = query.order("id", { ascending: false });

  const offset = (filters.page - 1) * filters.pageSize;
  query = query.range(offset, offset + filters.pageSize - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error("[support] inbox failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load the support inbox." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as QueueRow[];
  const total = typeof count === "number" ? count : rows.length;

  return NextResponse.json({
    conversations: rows.map(toView),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    hasMore: offset + rows.length < total,
    searchNote,
    counts: await viewCounts(actor.userId),
  });
}

/**
 * The number beside each chip.
 *
 * Head-only count queries — no rows are transferred, only the count. Six small
 * counts is cheaper than one query returning every unresolved conversation so
 * the browser can bucket them, and it is the only way the chips can be right on
 * page four.
 *
 * A failed count returns `null` for that chip rather than `0`. "Nothing needs
 * attention" and "we could not find out" must not look identical — this codebase
 * has shipped that confusion on four pages already.
 */
async function viewCounts(actorUserId: string): Promise<Record<string, number | null>> {
  const unresolved = ["open", "waiting_on_staff", "waiting_on_customer"];

  const base = () => routeServiceClient.from("staff_support_queue").select("id", { count: "exact", head: true });

  const count = async (apply: (q: ReturnType<typeof base>) => ReturnType<typeof base>): Promise<number | null> => {
    const { count: value, error } = await apply(base());
    return error ? null : value ?? 0;
  };

  const [needsAttention, waitingOnCustomer, unassigned, mine, highPriority] = await Promise.all([
    count((q) => q.in("status", ["open", "waiting_on_staff"])),
    count((q) => q.eq("status", "waiting_on_customer")),
    count((q) => q.in("status", unresolved).is("assigned_to", null)),
    count((q) => q.in("status", unresolved).eq("assigned_to", actorUserId)),
    count((q) => q.in("status", unresolved).in("priority", ["high", "urgent"])),
  ]);

  return { needs_attention: needsAttention, waiting_on_customer: waitingOnCustomer, unassigned, mine, high_priority: highPriority };
}

function toView(row: QueueRow): SupportInboxRow {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    category: row.category,
    status: row.status,
    priority: row.priority,
    isGuest: row.is_guest,
    // The account's display name when there is one, falling back to the label
    // snapshotted at creation. A deleted account keeps the second, which is why
    // the snapshot exists.
    requesterLabel: row.customer_display_name?.trim() || row.customer_username?.trim() || row.requester_label,
    requesterEmail: row.requester_email,
    customerId: row.customer_id,
    relatedOrderId: row.related_order_id,
    relatedOrderNumber: row.related_order_number,
    assignedTo: row.assigned_to,
    assignedToLabel: row.assigned_to_label,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    lastCustomerMessageAt: row.last_customer_message_at,
    lastStaffMessageAt: row.last_staff_message_at,
    messageCount: row.message_count ?? 0,
    noteCount: row.note_count ?? 0,
  };
}
