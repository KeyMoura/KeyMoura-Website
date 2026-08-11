"use client";

import { FormEvent, useState } from "react";

import { EmptyState, Notice } from "@/components/ui/DesignSystem";
import { useOrderWorkspace } from "@/components/staff/useOrderWorkspace";

/**
 * What this order cost the shop to make.
 *
 * ## Why this survived the consolidation
 *
 * Everything else in the retired "Production workspace" duplicated
 * `production_jobs`: its priority, its assignee, its start flag and its
 * checklist all had a better-modelled twin on the job. `order_cost_items` has
 * no twin. `production_jobs` records *time* (`estimated_minutes`,
 * `actual_minutes`) and a free-text `materials_required`, but nothing that adds
 * up to money, and there are real rows in this table. Deleting the only UI that
 * can read them would have orphaned live data to make a diff look tidier.
 *
 * So costing stays, on the Production tab, under a name that says what it is
 * rather than calling itself a workspace.
 *
 * **It is internal, and the wording has to keep saying so.** These are the
 * shop's material and labour costs; the customer's price is `agreed_price_cents`
 * and is edited on Payment. The two have been confused on this page before —
 * `tests/staff-order-workspace.test.ts` pins the sentence that separates them.
 */

const CATEGORIES = [
  { value: "material", label: "Material" },
  { value: "labor", label: "Labor" },
  { value: "shipping", label: "Shipping" },
  { value: "service", label: "Service" },
  { value: "other", label: "Other" },
] as const;

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const lineTotal = (item: { quantity: number; unit_cost_cents: number }) =>
  Math.round(Number(item.quantity) * item.unit_cost_cents);

const EMPTY_DRAFT = {
  description: "",
  category: "material",
  quantity: "1",
  unitCost: "",
  billable: false,
  notes: "",
};

export function OrderCostingPanel({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const { costs, error, loading, saving, act } = useOrderWorkspace(orderId);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const total = costs.reduce((sum, item) => sum + lineTotal(item), 0);
  const billable = costs.filter((item) => item.billable).reduce((sum, item) => sum + lineTotal(item), 0);

  async function addCost(event: FormEvent) {
    event.preventDefault();
    const ok = await act({
      action: "add_cost",
      description: draft.description,
      category: draft.category,
      quantity: Number(draft.quantity),
      unit_cost_cents: Math.round(Number(draft.unitCost) * 100),
      billable: draft.billable,
      notes: draft.notes,
    });
    if (ok) setDraft(EMPTY_DRAFT);
  }

  return (
    <div className="ui-card print:border-0 print:bg-white print:p-0 print:text-black">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-xs text-brand-textMuted print:text-zinc-600">
          Internal material and labour cost — not the customer&rsquo;s price, which is set on the Payment tab.
        </p>
        <div className="text-right text-xs">
          <div className="font-semibold">{money(total)} total</div>
          {billable ? <div className="text-brand-textMuted">{money(billable)} billable</div> : null}
        </div>
      </div>

      {costs.length ? (
        <div className="mt-3 overflow-hidden rounded-xl border border-[var(--border)]">
          {costs.map((item) => (
            <div
              key={item.id}
              className="grid grid-cols-[1fr_auto] gap-2 border-b border-[var(--border)] p-3 text-sm last:border-0"
            >
              <div>
                <div className="font-medium">{item.description}</div>
                <div className="text-xs text-brand-textMuted">
                  {item.category} · {Number(item.quantity)} × {money(item.unit_cost_cents)}
                  {item.billable ? " · billable" : ""}
                </div>
                {item.notes ? <p className="mt-1 text-xs text-brand-textMuted">{item.notes}</p> : null}
              </div>
              <div className="text-right">
                <div>{money(lineTotal(item))}</div>
                {canManage ? (
                  <button
                    type="button"
                    onClick={() => void act({ action: "delete_cost", item_id: item.id })}
                    className="mt-1 text-xs text-rose-300 print:hidden"
                    aria-label={`Remove ${item.description}`}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : loading ? null : (
        <EmptyState className="mt-3">No materials or costs recorded against this order.</EmptyState>
      )}

      {canManage ? (
        <form onSubmit={addCost} className="mt-3 grid gap-2 sm:grid-cols-2 print:hidden">
          <input
            required
            maxLength={240}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            className="ui-input sm:col-span-2"
            placeholder="Material, labor, or service"
            aria-label="What the cost is for"
          />
          <select
            value={draft.category}
            onChange={(event) => setDraft({ ...draft, category: event.target.value })}
            className="ui-input"
            aria-label="Cost category"
          >
            {CATEGORIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              required
              min="0.001"
              step="0.001"
              type="number"
              value={draft.quantity}
              onChange={(event) => setDraft({ ...draft, quantity: event.target.value })}
              className="ui-input"
              aria-label="Quantity"
            />
            <input
              required
              min="0"
              step=".01"
              type="number"
              value={draft.unitCost}
              onChange={(event) => setDraft({ ...draft, unitCost: event.target.value })}
              className="ui-input"
              placeholder="$ each"
              aria-label="Unit cost"
            />
          </div>
          <input
            maxLength={1000}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            className="ui-input sm:col-span-2"
            placeholder="Vendor, stock size, machine time…"
            aria-label="Notes"
          />
          <label className="flex items-center gap-2 text-xs text-brand-textMuted">
            <input
              type="checkbox"
              checked={draft.billable}
              onChange={(event) => setDraft({ ...draft, billable: event.target.checked })}
            />{" "}
            Include as billable cost
          </label>
          <button disabled={saving} className="ui-btn ui-btn-secondary text-sm disabled:opacity-50">
            Add cost
          </button>
        </form>
      ) : null}

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4 print:hidden">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
