import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import type { SupportCategory, SupportStatus } from "@/lib/support/domain";

/**
 * A customer's own support conversations.
 *
 * ## What makes this safe
 *
 * `.eq("customer_id", actor.userId)` is applied to the query, not to the result.
 * The difference matters: a row belonging to somebody else is never loaded, so
 * there is no filtering step that a later refactor can drop, and no window in
 * which another customer's record exists in this process's memory.
 *
 * There is deliberately no `userId` parameter. A customer's own id comes from
 * their session; accepting one from the request would mean the only thing
 * between two customers was a check somebody remembered to write.
 *
 * ## What is absent from the response
 *
 * `assigned_to`, `assigned_to_label` and `priority`. Who inside KeyMoura is
 * carrying a conversation, and how urgent we privately think it is, are staff
 * routing facts — a customer seeing "priority: low" on their refund question
 * learns something true and useless that can only annoy them. They are not
 * selected, so they cannot be leaked by a serializer change.
 */

export const runtime = "nodejs";

const CUSTOMER_COLUMNS =
  "id,reference,subject,category,status,related_order_id,created_at,last_message_at,resolved_at,closed_at";

const MAX_PAGE_SIZE = 50;

type Row = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  related_order_id: string | null;
  created_at: string;
  last_message_at: string;
  resolved_at: string | null;
  closed_at: string | null;
};

export async function GET(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const rawPage = Number(url.searchParams.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = (page - 1) * MAX_PAGE_SIZE;

  const { data, error, count } = await routeServiceClient
    .from("support_conversations")
    .select(CUSTOMER_COLUMNS, { count: "exact" })
    .eq("customer_id", actor.userId)
    .order("last_message_at", { ascending: false })
    // `id` breaks ties in the same direction, so two conversations touched in
    // the same millisecond cannot swap places between page one and page two.
    .order("id", { ascending: false })
    .range(offset, offset + MAX_PAGE_SIZE - 1);

  if (error) {
    console.error("[support] customer list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load your support requests." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as Row[];

  // Order numbers, resolved in one query rather than per row. Only the orders
  // this customer owns are looked up — an order that is linked but not theirs
  // (which the create route refuses, but which a staff link could produce) shows
  // no number rather than somebody else's.
  const orderIds = [...new Set(rows.map((row) => row.related_order_id).filter((id): id is string => Boolean(id)))];
  const orderNumbers = new Map<string, string | null>();
  if (orderIds.length) {
    const { data: orders } = await routeServiceClient
      .from("orders")
      .select("id,order_number")
      .in("id", orderIds)
      .eq("customer_id", actor.userId);
    for (const order of (orders ?? []) as { id: string; order_number: string | null }[]) {
      orderNumbers.set(order.id, order.order_number);
    }
  }

  const total = typeof count === "number" ? count : rows.length;

  return NextResponse.json({
    conversations: rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      subject: row.subject,
      category: row.category,
      status: row.status,
      relatedOrderId: orderNumbers.has(row.related_order_id ?? "") ? row.related_order_id : null,
      relatedOrderNumber: row.related_order_id ? orderNumbers.get(row.related_order_id) ?? null : null,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    })),
    total,
    page,
    pageSize: MAX_PAGE_SIZE,
    hasMore: offset + rows.length < total,
  });
}
