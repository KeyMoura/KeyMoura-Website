"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

/**
 * One product's stock: the figures, the live holds, and the adjustment ledger.
 *
 * The adjustment form is explicit throughout — nothing saves because a select
 * changed, a reason is always required, and a reduction confirms with the
 * before and after values spelled out before it is sent.
 */

type Detail = {
  product: {
    id: string;
    name: string;
    sku: string | null;
    tracked: boolean;
    madeToOrder: boolean;
    backordersAllowed: boolean;
    isPublished: boolean;
    onHand: number;
    reserved: number;
    available: number | null;
    lowStockThreshold: number;
  };
  reservations: { id: string; quantity: number; expiresAt: string; createdAt: string; orderId: string | null }[];
  history: {
    id: string;
    delta: number;
    quantity_before: number;
    quantity_after: number;
    reason: string;
    note: string | null;
    order_id: string | null;
    created_at: string;
  }[];
  historyPage: number;
  historyTotal: number;
  hasMoreHistory: boolean;
  openAlert: { level: string; threshold: number; created_at: string } | null;
};

const REASONS = [
  { value: "recount", label: "Stock recount" },
  { value: "damage", label: "Damaged" },
  { value: "loss", label: "Lost or missing" },
  { value: "found", label: "Found / previously miscounted" },
  { value: "production", label: "Made in the shop" },
  { value: "supplier_delivery", label: "Supplier delivery" },
  { value: "correction", label: "Correcting an earlier entry" },
  { value: "other", label: "Something else" },
];

const REASON_LABELS: Record<string, string> = {
  ...Object.fromEntries(REASONS.map((entry) => [entry.value, entry.label])),
  order_committed: "Sold",
  order_cancelled: "Order cancelled",
  return_restocked: "Return restocked",
  manual_set: "Manual set",
  manual_adjust: "Manual adjustment",
};

export default function StaffInventoryDetailPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = use(params);
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canManage = permissions.has("inventory.manage");

  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyPage, setHistoryPage] = useState(0);

  const [mode, setMode] = useState<"set" | "increment" | "decrement">("increment");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/staff/inventory/${productId}?page=${historyPage}`, {
        credentials: "same-origin",
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error || "Could not load this product.");
        return;
      }
      setError("");
      setDetail(payload as Detail);
    } catch {
      setError("Could not load this product.");
    } finally {
      setLoading(false);
    }
  }, [productId, historyPage]);

  useEffect(() => {
    if (accessLoading || !permissions.has("inventory.view")) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, accessLoading, access?.permissions]);

  const parsedAmount = Number(amount);
  const validAmount = Number.isInteger(parsedAmount) && parsedAmount >= 0 && amount.trim() !== "";

  // Before and after, computed for the confirmation so staff see the
  // consequence rather than the instruction.
  const projected = useMemo(() => {
    if (!detail || !validAmount) return null;
    const before = detail.product.onHand;
    const after = mode === "set" ? parsedAmount : mode === "increment" ? before + parsedAmount : before - parsedAmount;
    return { before, after, delta: after - before };
  }, [detail, validAmount, mode, parsedAmount]);

  const reducesStock = Boolean(projected && projected.delta < 0);
  const largeChange = Boolean(projected && Math.abs(projected.delta) >= 10);
  const needsConfirmation = reducesStock || largeChange;

  async function submitAdjustment() {
    if (!detail || !projected) return;
    setSubmitting(true);
    setFormError("");
    try {
      const response = await fetch(`/api/staff/inventory/${productId}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          amount: parsedAmount,
          reason,
          note,
          expectedQuantity: detail.product.onHand,
          // Keyed per submission so a double-click applies once.
          idempotencyKey: `${detail.product.onHand}:${mode}:${parsedAmount}:${reason}`,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setFormError(payload?.error || "Could not adjust stock.");
        void load();
        return;
      }
      setSaved(`Stock moved from ${payload.quantityBefore} to ${payload.quantityAfter}.`);
      setAmount("");
      setReason("");
      setNote("");
      setConfirming(false);
      void load();
    } catch {
      setFormError("Could not adjust stock. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  }

  if (accessLoading || loading) return <div className="ui-card text-sm text-brand-textMuted">Loading…</div>;
  if (!permissions.has("inventory.view")) {
    return <AccessDeniedCard message="You need the inventory.view permission to see stock levels." />;
  }
  if (error) return <p role="alert" className="ui-notice ui-notice-danger text-sm">{error}</p>;
  if (!detail) return null;

  const { product } = detail;

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">
          <Link href="/staff/inventory" className="hover:text-brand-accent">
            Inventory
          </Link>
        </p>
        <h1 className="mt-1 text-3xl font-semibold">{product.name}</h1>
        <p className="mt-2 text-sm text-brand-textMuted">
          {product.sku ? `SKU ${product.sku} · ` : ""}
          {product.tracked ? "Tracked" : product.madeToOrder ? "Made to order" : "Not tracked"}
          {product.backordersAllowed ? " · backorders allowed" : ""}
        </p>
      </header>

      {detail.openAlert ? (
        <p className="ui-notice ui-notice-warning text-sm">
          {detail.openAlert.level === "out" ? "Out of stock" : "Low stock"} — raised{" "}
          {new Date(detail.openAlert.created_at).toLocaleDateString()} at a threshold of {detail.openAlert.threshold}.
        </p>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Current quantities">
        <Figure label="On hand" value={product.tracked ? product.onHand : "—"} hint="In the building" />
        <Figure label="Reserved" value={product.reserved} hint="Held by a checkout in progress" />
        <Figure
          label="Available"
          value={product.available === null ? "—" : product.available}
          hint="What the next customer can buy"
        />
      </section>

      {product.tracked ? (
        <section className="ui-card" aria-labelledby="adjust-heading">
          <h2 id="adjust-heading" className="text-lg font-semibold">
            Adjust stock
          </h2>
          {!canManage ? (
            <p className="mt-2 text-sm text-brand-textMuted">
              You need the inventory.manage permission to change stock levels.
            </p>
          ) : (
            <form
              className="mt-4 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved("");
                if (!validAmount) {
                  setFormError("Enter a whole number of units.");
                  return;
                }
                if (!reason) {
                  setFormError("Choose a reason for this adjustment.");
                  return;
                }
                if (reason === "other" && note.trim().length < 3) {
                  setFormError("Describe the reason for this adjustment.");
                  return;
                }
                setFormError("");
                // Reductions and large moves confirm first, showing the
                // before and after rather than just asking "are you sure".
                if (needsConfirmation && !confirming) {
                  setConfirming(true);
                  return;
                }
                void submitAdjustment();
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-sm" htmlFor="adjust-mode">
                    Change
                  </label>
                  <select
                    id="adjust-mode"
                    className="ui-input mt-1 w-full"
                    value={mode}
                    onChange={(event) => {
                      setConfirming(false);
                      setMode(event.target.value as "set" | "increment" | "decrement");
                    }}
                  >
                    <option value="increment">Add stock</option>
                    <option value="decrement">Remove stock</option>
                    <option value="set">Set exact quantity</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm" htmlFor="adjust-amount">
                    Units
                  </label>
                  <input
                    id="adjust-amount"
                    className="ui-input mt-1 w-full"
                    inputMode="numeric"
                    value={amount}
                    onChange={(event) => {
                      setConfirming(false);
                      setAmount(event.target.value);
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm" htmlFor="adjust-reason">
                  Reason
                </label>
                <select
                  id="adjust-reason"
                  className="ui-input mt-1 w-full"
                  value={reason}
                  onChange={(event) => {
                    setConfirming(false);
                    setReason(event.target.value);
                  }}
                >
                  <option value="">Choose a reason…</option>
                  {REASONS.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-sm" htmlFor="adjust-note">
                  Note {reason === "other" ? "(required)" : "(optional)"}
                </label>
                <input
                  id="adjust-note"
                  className="ui-input mt-1 w-full"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  maxLength={500}
                />
              </div>

              {confirming && projected ? (
                <p role="alert" className="ui-notice ui-notice-warning text-sm">
                  This will move {product.name} from <strong>{projected.before}</strong> to{" "}
                  <strong>{projected.after}</strong> ({projected.delta > 0 ? "+" : ""}
                  {projected.delta}). Press Apply again to confirm.
                </p>
              ) : null}

              {formError ? (
                <p role="alert" className="ui-notice ui-notice-danger text-sm">
                  {formError}
                </p>
              ) : null}
              {saved ? (
                <p role="status" className="ui-notice ui-notice-success text-sm">
                  {saved}
                </p>
              ) : null}

              <div>
                <button type="submit" disabled={submitting} className="ui-btn ui-btn-primary disabled:opacity-50">
                  {submitting ? "Applying…" : confirming ? "Apply — confirm" : "Apply"}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <section className="ui-card" aria-labelledby="holds-heading">
        <h2 id="holds-heading" className="text-lg font-semibold">
          Active holds
        </h2>
        {!detail.reservations.length ? (
          <p className="mt-2 text-sm text-brand-textMuted">Nothing is held right now.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {detail.reservations.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3">
                <span>
                  {entry.quantity} unit{entry.quantity === 1 ? "" : "s"}
                  {entry.orderId ? (
                    <>
                      {" · "}
                      <Link href={`/staff/orders/${entry.orderId}`} className="underline hover:text-brand-accent">
                        order
                      </Link>
                    </>
                  ) : null}
                </span>
                <span className="text-xs text-brand-textMuted">
                  lapses {new Date(entry.expiresAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ui-card" aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-lg font-semibold">
          Movement history
        </h2>
        {!detail.history.length ? (
          <p className="mt-2 text-sm text-brand-textMuted">No stock movements recorded.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <caption className="sr-only">Every recorded stock movement for this product</caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-brand-textMuted">
                  <th scope="col" className="p-2">When</th>
                  <th scope="col" className="p-2">Reason</th>
                  <th scope="col" className="p-2 text-right">Change</th>
                  <th scope="col" className="p-2 text-right">After</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="p-2 text-brand-textMuted">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="p-2">
                      {REASON_LABELS[row.reason] ?? row.reason}
                      {row.order_id ? (
                        <>
                          {" · "}
                          <Link href={`/staff/orders/${row.order_id}`} className="underline hover:text-brand-accent">
                            order
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td className={`p-2 text-right tabular-nums ${row.delta > 0 ? "text-emerald-300" : "text-amber-200"}`}>
                      {row.delta > 0 ? "+" : ""}
                      {row.delta}
                    </td>
                    <td className="p-2 text-right tabular-nums">{row.quantity_after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className="mt-3 flex items-center justify-between text-sm" aria-label="History pagination">
          <button
            type="button"
            className="ui-btn ui-btn-secondary disabled:opacity-50"
            disabled={historyPage === 0}
            onClick={() => setHistoryPage((current) => Math.max(0, current - 1))}
          >
            Newer
          </button>
          <span className="text-xs text-brand-textMuted">{detail.historyTotal} movements</span>
          <button
            type="button"
            className="ui-btn ui-btn-secondary disabled:opacity-50"
            disabled={!detail.hasMoreHistory}
            onClick={() => setHistoryPage((current) => current + 1)}
          >
            Older
          </button>
        </nav>
      </section>
    </main>
  );
}

function Figure({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="ui-card">
      <p className="text-xs uppercase tracking-wide text-brand-textMuted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-brand-textMuted">{hint}</p>
    </div>
  );
}
