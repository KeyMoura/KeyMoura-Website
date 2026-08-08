"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { LoadingState, PageHeader, StaffPage } from "@/components/staff/StaffPage";
import { EmptyState, Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { discountStatus, discountValueLabel, parseDiscountValue } from "@/lib/commerce/discountAdmin";

/**
 * Discount code management.
 *
 * The engine that decides whether a code applies has existed since
 * 20260802020300; this is the surface that lets staff author one. Every rule
 * shown here is enforced again server-side and again by a database constraint,
 * so the form is a convenience rather than a control.
 */

const primary = "ui-btn ui-btn-primary disabled:opacity-50";
const subtle = "ui-btn ui-btn-ghost text-sm disabled:opacity-50";

type DiscountCodeRow = {
  id: string;
  code: string;
  description: string | null;
  discount_type: "fixed" | "percent";
  discount_value: number;
  max_discount_cents: number | null;
  minimum_subtotal_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  max_total_uses: number | null;
  max_uses_per_customer: number | null;
  first_order_only: boolean;
  is_stackable: boolean;
  total_uses: number;
  archived_at: string | null;
};

type TargetRow = { target_type: string; target_id: string; is_exclusion: boolean };
type NamedRow = { id: string; name: string };
type Usage = { count: number; amountCents: number };

const money = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
const dateInput = (value: string | null) => (value ? new Date(value).toISOString().slice(0, 10) : "");

const emptyDraft = {
  code: "",
  description: "",
  discountType: "percent" as "percent" | "fixed",
  discountValue: "10",
  maxDiscount: "",
  minimumSubtotal: "",
  startsAt: "",
  endsAt: "",
  isActive: true,
  maxTotalUses: "",
  maxUsesPerCustomer: "",
  firstOrderOnly: false,
  isStackable: false,
};

type Draft = typeof emptyDraft;

export default function StaffDiscountsPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canManage = permissions.has("catalog.discounts.manage");

  const [codes, setCodes] = useState<DiscountCodeRow[]>([]);
  const [targets, setTargets] = useState<Record<string, TargetRow[]>>({});
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [products, setProducts] = useState<NamedRow[]>([]);
  const [categories, setCategories] = useState<NamedRow[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftTargets, setDraftTargets] = useState<TargetRow[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  /**
   * Whether to show the value field's error yet.
   *
   * A brand-new form must not open already marked invalid, and a field being
   * edited must not go red between the moment it is emptied and the moment the
   * first digit lands. So the message waits for a blur or a submit attempt.
   */
  const [valueTouched, setValueTouched] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/staff/catalog/discounts", { credentials: "same-origin" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not load discount codes.");
      setCodes(payload.codes ?? []);
      setTargets(payload.targets ?? {});
      setUsage(payload.usage ?? {});
      setProducts(payload.products ?? []);
      setCategories(payload.categories ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load discount codes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  const visible = codes.filter((code) => (showArchived ? true : !code.archived_at));

  // The same function the route runs, so the sentence under the field is the
  // sentence the server would have sent back.
  const valueCheck = parseDiscountValue(draft.discountType, draft.discountValue);
  const showValueError = valueTouched && !valueCheck.ok;

  /**
   * Switching type clears the value rather than carrying it over.
   *
   * "10" means 10% in one mode and $10.00 in the other — the same digits, a
   * very different offer. Carrying the number across is how someone publishes a
   * ten-dollar code they meant as ten percent. Clearing is the honest default,
   * and the hint beneath the field immediately says what the new mode wants.
   */
  function changeDiscountType(discountType: "percent" | "fixed") {
    if (discountType === draft.discountType) return;
    setDraft({ ...draft, discountType, discountValue: "" });
    setValueTouched(false);
  }

  function startNew() {
    setEditingId(null);
    setDraft(emptyDraft);
    setDraftTargets([]);
    setValueTouched(false);
    setMessage("");
    setError("");
  }

  function startEdit(code: DiscountCodeRow) {
    setEditingId(code.id);
    setDraft({
      code: code.code,
      description: code.description ?? "",
      discountType: code.discount_type,
      discountValue:
        code.discount_type === "percent" ? String(code.discount_value) : (code.discount_value / 100).toFixed(2),
      maxDiscount: code.max_discount_cents == null ? "" : (code.max_discount_cents / 100).toFixed(2),
      minimumSubtotal: code.minimum_subtotal_cents ? (code.minimum_subtotal_cents / 100).toFixed(2) : "",
      startsAt: dateInput(code.starts_at),
      endsAt: dateInput(code.ends_at),
      isActive: code.is_active,
      maxTotalUses: code.max_total_uses == null ? "" : String(code.max_total_uses),
      maxUsesPerCustomer: code.max_uses_per_customer == null ? "" : String(code.max_uses_per_customer),
      firstOrderOnly: code.first_order_only,
      isStackable: code.is_stackable,
    });
    setDraftTargets(targets[code.id] ?? []);
    // An existing code is valid by construction, so editing one must not open
    // with an error showing.
    setValueTouched(false);
    setMessage("");
    setError("");
  }

  function toggleTarget(type: "product" | "category", id: string, isExclusion: boolean) {
    setDraftTargets((current) => {
      const match = (row: TargetRow) =>
        row.target_type === type && row.target_id === id && row.is_exclusion === isExclusion;
      return current.some(match)
        ? current.filter((row) => !match(row))
        : [...current, { target_type: type, target_id: id, is_exclusion: isExclusion }];
    });
  }

  const hasTarget = (type: string, id: string, isExclusion: boolean) =>
    draftTargets.some((row) => row.target_type === type && row.target_id === id && row.is_exclusion === isExclusion);

  async function save(event: FormEvent) {
    event.preventDefault();

    // Stop here rather than spending a round trip to be told the same thing,
    // and move focus to the field so a keyboard user is put where the problem
    // is instead of hunting for it.
    if (!valueCheck.ok) {
      setValueTouched(true);
      setMessage("");
      setError("");
      document.getElementById("discount-value")?.focus();
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    const body = {
      ...draft,
      targets: draftTargets.map((row) => ({
        targetType: row.target_type,
        targetId: row.target_id,
        isExclusion: row.is_exclusion,
      })),
    };

    try {
      const response = await fetch(
        editingId ? `/api/staff/catalog/discounts/${editingId}` : "/api/staff/catalog/discounts",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Could not save the code.");
      // A 207 means the code saved but its targeting did not; surface that
      // rather than reporting a clean success.
      setMessage(payload?.error ? payload.error : editingId ? "Code updated." : "Code created.");
      startNew();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the code.");
    } finally {
      setBusy(false);
    }
  }

  async function setActive(code: DiscountCodeRow, isActive: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/staff/catalog/discounts/${code.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ isActive }),
      });
      if (!response.ok) throw new Error("Could not update the code.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the code.");
    } finally {
      setBusy(false);
    }
  }

  async function archive(code: DiscountCodeRow) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/staff/catalog/discounts/${code.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Could not archive the code.");
      setMessage(`${code.code} archived. Existing orders keep their discount.`);
      if (editingId === code.id) startNew();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not archive the code.");
    } finally {
      setBusy(false);
    }
  }

  if (accessLoading) return <LoadingState>Loading discount codes…</LoadingState>;

  if (!canManage) {
    return <AccessDeniedCard message="You do not have permission to manage discount codes." />;
  }

  return (
    // `page-container` here was a second max-width box inside the staff
    // shell's own, so Discounts rendered narrower than Products beside it in
    // the same menu group. `StaffPage` sets no width and inherits the shell's.
    <StaffPage>
      <PageHeader
        title="Discounts"
        description="Codes are applied and priced by KeyMoura, not by Stripe. A customer submits a code; the amount it is worth is always calculated here and confirmed again immediately before payment."
      />

      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {message ? (
        <Notice tone="success" role="status">
          {message}
        </Notice>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start">
        <section aria-labelledby="discount-list" className="ui-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="discount-list" className="text-lg font-semibold">
              {visible.length} code{visible.length === 1 ? "" : "s"}
            </h2>
            <label className="flex items-center gap-2 text-sm text-brand-textMuted">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              Show archived
            </label>
          </div>

          {loading ? (
            <p aria-live="polite" className="mt-6 text-sm text-brand-textMuted">
              Loading discount codes…
            </p>
          ) : !visible.length ? (
            <EmptyState className="mt-6">
              <p className="font-medium text-brand-text">No discount codes yet.</p>
              <p className="mt-1 text-sm">Create one on the right. Nothing is offered to customers until it is active.</p>
            </EmptyState>
          ) : (
            <ul className="mt-4 divide-y divide-[var(--border)]">
              {visible.map((code) => {
                const status = discountStatus(code);
                const used = usage[code.id] ?? { count: 0, amountCents: 0 };
                const codeTargets = targets[code.id] ?? [];

                return (
                  <li key={code.id} className="py-4 first:pt-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-mono text-base font-semibold">{code.code}</h3>
                          <span className="ui-badge">{discountValueLabel(code)}</span>
                          {status ? (
                            <span className="ui-badge ui-badge-warning">{status}</span>
                          ) : (
                            <span className="ui-badge ui-badge-success">Live</span>
                          )}
                          {code.is_stackable ? <span className="ui-badge">Stackable</span> : null}
                          {code.first_order_only ? <span className="ui-badge">First order only</span> : null}
                        </div>

                        {code.description ? (
                          <p className="mt-1 text-sm text-brand-textMuted">{code.description}</p>
                        ) : null}

                        <p className="mt-1 text-xs text-brand-textMuted">
                          Redeemed {used.count} time{used.count === 1 ? "" : "s"} · {money(used.amountCents)} given
                          {code.max_total_uses != null ? ` · ${code.total_uses} of ${code.max_total_uses} held` : ""}
                          {code.minimum_subtotal_cents ? ` · min ${money(code.minimum_subtotal_cents)}` : ""}
                          {code.max_discount_cents != null ? ` · capped at ${money(code.max_discount_cents)}` : ""}
                        </p>

                        {codeTargets.length ? (
                          <p className="mt-1 text-xs text-brand-textMuted">
                            {codeTargets.filter((row) => !row.is_exclusion).length} inclusion
                            {codeTargets.filter((row) => !row.is_exclusion).length === 1 ? "" : "s"},{" "}
                            {codeTargets.filter((row) => row.is_exclusion).length} exclusion
                            {codeTargets.filter((row) => row.is_exclusion).length === 1 ? "" : "s"}
                          </p>
                        ) : (
                          <p className="mt-1 text-xs text-brand-textMuted">Applies to the whole cart</p>
                        )}
                      </div>

                      <div className="ui-action-row">
                        <button type="button" onClick={() => startEdit(code)} className={subtle} disabled={busy}>
                          Edit
                        </button>
                        {!code.archived_at ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void setActive(code, !code.is_active)}
                              className={subtle}
                              disabled={busy}
                            >
                              {code.is_active ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void archive(code)}
                              className="ui-btn ui-btn-danger text-sm disabled:opacity-50"
                              disabled={busy}
                            >
                              Archive
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <form onSubmit={save} className="ui-card lg:sticky lg:top-24">
          <h2 className="text-lg font-semibold">{editingId ? "Edit code" : "New code"}</h2>

          <label className="ui-label mt-4 block" htmlFor="discount-code-input">
            Code
          </label>
          <input
            id="discount-code-input"
            required
            value={draft.code}
            onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })}
            placeholder="SPRING10"
            className="ui-input mt-1 w-full font-mono"
          />

          <label className="ui-label mt-3 block" htmlFor="discount-description">
            Internal description
          </label>
          <input
            id="discount-description"
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            className="ui-input mt-1 w-full"
          />

          <fieldset className="mt-4">
            <legend className="ui-label">Discount</legend>
            <div className="mt-1 flex gap-2">
              <select
                aria-label="Discount type"
                value={draft.discountType}
                onChange={(event) => changeDiscountType(event.target.value as "percent" | "fixed")}
                className="ui-input"
              >
                <option value="percent">Percent</option>
                <option value="fixed">Fixed amount</option>
              </select>
              <input
                id="discount-value"
                aria-label={draft.discountType === "percent" ? "Percent off" : "Dollars off"}
                required
                // Honest per type: a percentage is a whole number, so a decimal
                // keypad on mobile would invite a value the column cannot hold.
                inputMode={draft.discountType === "percent" ? "numeric" : "decimal"}
                aria-invalid={showValueError || undefined}
                aria-describedby={showValueError ? "discount-value-error" : "discount-value-hint"}
                value={draft.discountValue}
                onChange={(event) => setDraft({ ...draft, discountValue: event.target.value })}
                onBlur={() => setValueTouched(true)}
                className="ui-input flex-1"
              />
              <span className="self-center text-sm text-brand-textMuted">
                {draft.discountType === "percent" ? "%" : "$"}
              </span>
            </div>

            {/* One live region for both states, so a screen reader hears the
                problem as it appears rather than only on submit. The hint says
                up front what the field will accept, which is the cheapest way
                to prevent the error in the first place. */}
            {showValueError ? (
              <p id="discount-value-error" role="alert" className="mt-1 text-xs text-amber-200">
                {valueCheck.ok ? "" : valueCheck.problem}
              </p>
            ) : (
              <p id="discount-value-hint" className="mt-1 text-xs text-brand-textMuted">
                {draft.discountType === "percent"
                  ? "A whole number from 1 to 100."
                  : "Dollars and cents, more than zero."}
              </p>
            )}
          </fieldset>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="ui-label block" htmlFor="discount-max">
                Max discount ($)
              </label>
              <input
                id="discount-max"
                inputMode="decimal"
                value={draft.maxDiscount}
                onChange={(event) => setDraft({ ...draft, maxDiscount: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
            <div>
              <label className="ui-label block" htmlFor="discount-min">
                Min subtotal ($)
              </label>
              <input
                id="discount-min"
                inputMode="decimal"
                value={draft.minimumSubtotal}
                onChange={(event) => setDraft({ ...draft, minimumSubtotal: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
            <div>
              <label className="ui-label block" htmlFor="discount-starts">
                Starts
              </label>
              <input
                id="discount-starts"
                type="date"
                value={draft.startsAt}
                onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
            <div>
              <label className="ui-label block" htmlFor="discount-ends">
                Ends
              </label>
              <input
                id="discount-ends"
                type="date"
                value={draft.endsAt}
                onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
            <div>
              <label className="ui-label block" htmlFor="discount-total-uses">
                Total uses
              </label>
              <input
                id="discount-total-uses"
                inputMode="numeric"
                value={draft.maxTotalUses}
                onChange={(event) => setDraft({ ...draft, maxTotalUses: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
            <div>
              <label className="ui-label block" htmlFor="discount-per-customer">
                Uses per customer
              </label>
              <input
                id="discount-per-customer"
                inputMode="numeric"
                value={draft.maxUsesPerCustomer}
                onChange={(event) => setDraft({ ...draft, maxUsesPerCustomer: event.target.value })}
                className="ui-input mt-1 w-full"
              />
            </div>
          </div>

          <div className="mt-4 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })}
              />
              Active
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.firstOrderOnly}
                onChange={(event) => setDraft({ ...draft, firstOrderOnly: event.target.checked })}
              />
              First order only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.isStackable}
                onChange={(event) => setDraft({ ...draft, isStackable: event.target.checked })}
              />
              Can stack with other codes
            </label>
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium">
              Targeting ({draftTargets.length} rule{draftTargets.length === 1 ? "" : "s"})
            </summary>
            <p className="mt-2 text-xs text-brand-textMuted">
              With no rules the code applies to the whole cart. Exclusions always win over inclusions.
            </p>

            {[
              { label: "Categories", rows: categories, type: "category" as const },
              { label: "Products", rows: products, type: "product" as const },
            ].map((group) => (
              <fieldset key={group.type} className="mt-3">
                <legend className="ui-label">{group.label}</legend>
                <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                  {group.rows.map((row) => (
                    <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{row.name}</span>
                      <span className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => toggleTarget(group.type, row.id, false)}
                          aria-pressed={hasTarget(group.type, row.id, false)}
                          className={`ui-chip ${hasTarget(group.type, row.id, false) ? "ui-badge-success" : ""}`}
                        >
                          Include
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleTarget(group.type, row.id, true)}
                          aria-pressed={hasTarget(group.type, row.id, true)}
                          className={`ui-chip ${hasTarget(group.type, row.id, true) ? "ui-badge-danger" : ""}`}
                        >
                          Exclude
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </details>

          <div className="ui-action-row mt-5">
            <button type="submit" disabled={busy} className={primary}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Create code"}
            </button>
            {editingId ? (
              <button type="button" onClick={startNew} className={subtle} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </StaffPage>
  );
}
