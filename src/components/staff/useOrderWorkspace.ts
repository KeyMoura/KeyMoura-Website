"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * The one reader of `/api/staff/orders/[id]/workspace`.
 *
 * ## Why this exists
 *
 * That endpoint used to have exactly one caller — `StaffOrderWorkspace`, a
 * single panel that drew priority, an assignee, a "Production started" flag, a
 * checklist and a cost table together under the heading "Production workspace".
 * Retiring the duplicated production state split the survivors across two tabs:
 * order triage belongs on **Overview** (it is a property of the order, and an
 * order with no shop work still has an owner and an urgency), and costing
 * belongs on **Production**.
 *
 * Two panels reading one endpoint is the thing worth being careful about, so
 * the request lives here once. `TabPanel` unmounts the inactive tab, so in
 * practice only one of the two is ever mounted and this is one request either
 * way — but the shared hook means it stays one request if that ever changes,
 * rather than two components racing the same URL.
 *
 * `checklist` is deliberately **not** exposed. `order_checklist_items` is empty
 * in production and its job is done by `production_job_tasks`; the endpoint
 * still returns it, and this hook drops it on the floor rather than tempting a
 * future panel into reviving the second task list.
 */

export type OrderWorkspace = {
  priority: "low" | "normal" | "high" | "urgent";
  assigned_to: string | null;
  started_at: string | null;
};

export type OrderCostItem = {
  id: string;
  description: string;
  category: string;
  quantity: number;
  unit_cost_cents: number;
  billable: boolean;
  notes: string | null;
};

export type StaffOption = { id: string; display_name: string | null; username: string | null };

const DEFAULT_WORKSPACE: OrderWorkspace = { priority: "normal", assigned_to: null, started_at: null };

export function useOrderWorkspace(orderId: string) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [workspace, setWorkspace] = useState<OrderWorkspace>(DEFAULT_WORKSPACE);
  const [costs, setCosts] = useState<OrderCostItem[]>([]);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const headers = useCallback(async () => {
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, [supabase]);

  const load = useCallback(async () => {
    const response = await fetch(`/api/staff/orders/${orderId}/workspace`, { headers: await headers() });
    const data = await response.json().catch(() => null);
    setLoading(false);
    if (!response.ok) {
      setError(data?.error || "Could not load this order's planning and costs");
      return;
    }
    setWorkspace(data.workspace ?? DEFAULT_WORKSPACE);
    setCosts(data.costs ?? []);
    setStaff(data.staff ?? []);
    setError("");
  }, [headers, orderId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /**
   * Send one action and reload.
   *
   * Returns whether it succeeded, so a form can decide whether to clear itself
   * rather than wiping what the person typed on a failed request.
   */
  const act = useCallback(
    async (payload: Record<string, unknown>) => {
      setSaving(true);
      const response = await fetch(`/api/staff/orders/${orderId}/workspace`, {
        method: "PATCH",
        headers: await headers(),
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);
      setSaving(false);
      if (!response.ok) {
        setError(data?.error || "Could not save that change");
        return false;
      }
      await load();
      return true;
    },
    [headers, load, orderId]
  );

  return { workspace, setWorkspace, costs, staff, error, loading, saving, act, reload: load };
}
