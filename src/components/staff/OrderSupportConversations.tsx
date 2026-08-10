"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { EmptyState, ErrorState, LoadingState, Row, Rows, Section } from "@/components/staff/StaffPage";
import { StatusChip } from "@/components/staff/StaffPage";
import { Badge } from "@/components/ui/DesignSystem";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { SUPPORT_CATEGORY_SHORT, formatSupportAge, type SupportCategory } from "@/lib/support/domain";

/**
 * Support conversations linked to one order, shown on the order workspace.
 *
 * ## Where this sits, and why
 *
 * Inside the order's **Messages** tab, immediately under the order's own thread.
 * Those are two different conversations that both exist about this order — the
 * thread on the order, and any support request a customer opened that names it —
 * and a staff member reading one needs to know the other exists. Putting them on
 * separate tabs would mean answering half a conversation.
 *
 * ## A list, not the thread
 *
 * The conversation is read and replied to at `/staff/support/[id]`, and only
 * there. Rendering the messages here too would be a second surface where an
 * internal note is on screen, and a second place to keep the visibility rule
 * right.
 *
 * The data comes from the inbox's own endpoint with `?order=`, not a new route.
 */

type Item = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: string;
  priority: string;
  requesterLabel: string;
  isGuest: boolean;
  assignedToLabel: string | null;
  lastMessageAt: string;
};

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: Item[]; total: number };

export function OrderSupportConversations({ orderId }: { orderId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { data: session } = await supabaseBrowser().auth.getSession();
      const token = session?.session?.access_token;
      if (!token) {
        setState({ kind: "hidden" });
        return;
      }
      const res = await fetch(`/api/staff/support?order=${orderId}&view=all&sort=recent_activity`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      /*
       * A viewer without `support.view` sees nothing at all, rather than an
       * error. This is a *secondary* panel on somebody else's page: a shop hand
       * managing tracking is not failing at anything by lacking a permission
       * they were never meant to have, and a red box on their order page would
       * say otherwise.
       *
       * A genuine failure is still shown, because "no support conversations" and
       * "we could not find out" must not look the same.
       */
      if (res.status === 403) {
        setState({ kind: "hidden" });
        return;
      }
      if (!res.ok) throw new Error("failed");
      const body = (await res.json()) as { conversations?: Item[]; total?: number };
      setState({ kind: "ready", items: body.conversations ?? [], total: body.total ?? 0 });
    } catch {
      setState({ kind: "error", message: "Could not load support conversations for this order." });
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "hidden") return null;

  return (
    <Section
      title="Support conversations"
      description="Support requests the customer opened that name this order. Read and reply in support."
      headingLevel={3}
      actions={
        <Link href={`/staff/support?order=${orderId}&view=all`} className="ui-btn ui-btn-secondary">
          Open in support →
        </Link>
      }
    >
      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "error" ? <ErrorState onRetry={() => void load()}>{state.message}</ErrorState> : null}

      {state.kind === "ready" && !state.items.length ? (
        <EmptyState>No support conversations name this order.</EmptyState>
      ) : null}

      {state.kind === "ready" && state.items.length ? (
        <Rows>
          {state.items.map((item) => (
            <Row
              key={item.id}
              href={`/staff/support/${item.id}`}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{item.reference}</span>
                  <span>{item.subject}</span>
                </span>
              }
              detail={
                <>
                  {item.requesterLabel}
                  {item.isGuest ? " · guest" : ""} · {SUPPORT_CATEGORY_SHORT[item.category]} ·{" "}
                  {formatSupportAge(item.lastMessageAt)}
                </>
              }
              meta={item.assignedToLabel ? `Owned by ${item.assignedToLabel}` : "Unassigned"}
              aside={
                <>
                  {item.priority === "urgent" || item.priority === "high" ? (
                    <Badge tone={item.priority === "urgent" ? "danger" : "warning"}>{item.priority}</Badge>
                  ) : null}
                  <StatusChip value={item.status} />
                </>
              }
            />
          ))}
        </Rows>
      ) : null}
    </Section>
  );
}
