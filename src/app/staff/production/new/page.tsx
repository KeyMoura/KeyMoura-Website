"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Notice, Panel } from "@/components/ui/DesignSystem";
import { JobForm, emptyJobDraft, type JobDraftState } from "@/components/staff/production/JobForm";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

/**
 * Raising a production job.
 *
 * Accepts `orderId`, `productId` and `customerId` in the query string so the
 * staff order page can hand off with the job already linked, rather than making
 * somebody paste identifiers between two tabs.
 */

const primary = "ui-btn ui-btn-primary disabled:opacity-50";
const subtle = "ui-btn ui-btn-ghost text-sm disabled:opacity-50";

function NewJobContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canManage = permissions.has("production.manage");

  const orderId = params.get("orderId");
  const orderItemId = params.get("orderItemId");
  const productId = params.get("productId");
  const customerId = params.get("customerId");
  const presetTitle = params.get("title");
  /** Display only — never stored. The job's link is `orderId`; this is what to call it. */
  const orderNumber = params.get("orderNumber");
  const presetQuantity = params.get("quantity");

  const [draft, setDraft] = useState<JobDraftState>(() => ({
    ...emptyJobDraft,
    /*
     * The title names the order as well as the product.
     *
     * A queue of jobs all called "Shift knob" is unreadable, and the job number
     * is the shop's reference rather than the customer's. Prefilled, not forced:
     * it is an ordinary text field and staff can rewrite it.
     */
    title: presetTitle ? (orderNumber ? `${presetTitle} — ${orderNumber}` : presetTitle) : "",
    // An order for six is six to make. Defaulting to 1 beside an order that says
    // six is the kind of quiet wrong answer that reaches the shop floor.
    quantity: presetQuantity && Number(presetQuantity) > 0 ? String(Math.trunc(Number(presetQuantity))) : "1",
  }));
  const [people, setPeople] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The assignee list comes from the queue endpoint, which already resolves the
  // staff it knows about. A dedicated staff-directory endpoint is not part of
  // this pass; see the ledger.
  useEffect(() => {
    if (!canManage) return;
    void (async () => {
      try {
        const response = await fetch("/api/staff/production/jobs?scope=all&limit=100", {
          credentials: "same-origin",
        });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.people) setPeople(body.people);
      } catch {
        // A missing assignee list must not stop a job being raised.
      }
    })();
  }, [canManage]);

  const patch = useCallback((next: Partial<JobDraftState>) => {
    setDraft((current) => ({ ...current, ...next }));
    setErrors([]);
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setError("");
    setErrors([]);
    try {
      const response = await fetch("/api/staff/production/jobs", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        // The link columns are sent alongside the draft rather than being part
        // of it: `JobForm` has no control for any of them, which is exactly the
        // property that stops an ordinary save from rewriting what a job is
        // attached to. `parseJobDraft` resolves each with `uuid()`, so an absent
        // one becomes null rather than throwing.
        body: JSON.stringify({ ...draft, orderId, orderItemId, productId, customerId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (Array.isArray(body?.errors) && body.errors.length) setErrors(body.errors);
        throw new Error(body?.error || "Could not create the job.");
      }
      router.push(`/staff/production/${body.job.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the job.");
      setBusy(false);
    }
  }, [draft, orderId, orderItemId, productId, customerId, router]);

  if (accessLoading) {
    return (
      <div className="page-container">
        <p className="text-sm text-brand-textMuted" role="status">
          Checking your access…
        </p>
      </div>
    );
  }

  if (!canManage) {
    return (
      <AccessDeniedCard
        title="You cannot raise jobs"
        message="Creating production work needs the production management permission."
        backHref="/staff/production"
        backLabel="Back to the queue"
      />
    );
  }

  return (
    <div className="page-container space-y-6">
      <nav aria-label="Breadcrumb">
        <Link href="/staff/production" className="text-sm text-brand-textMuted underline">
          ← Production queue
        </Link>
      </nav>

      <header>
        <h1 className="text-2xl font-semibold">New production job</h1>
        <p className="mt-1 text-sm text-brand-textMuted">
          A job number is assigned when it is created. It starts as not started.
        </p>
      </header>

      {/*
        Which order, by name.

        This used to read "This job will be linked to the order it was raised
        from" — true, and unverifiable from where the reader is standing. Naming
        the order and linking to it means a staff member who arrived here from
        the wrong tab can see it before they create anything.
      */}
      {orderId ? (
        <Notice tone="info">
          <p>
            <strong>Source order:</strong>{" "}
            <Link href={`/staff/orders/${orderId}`} className="text-brand-accent underline hover:no-underline">
              {orderNumber ? `Order ${orderNumber}` : "Open the order"}
            </Link>
          </p>
          <p className="mt-1 text-sm">
            Creating this job links it to that order. The customer and product come from the order, and
            editing the job later never changes the link.
          </p>
        </Notice>
      ) : (
        <Notice tone="info">
          This job will not be attached to an order — stock work. Raise it from an order instead if it is
          for a customer.
        </Notice>
      )}

      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}

      {errors.length ? (
        <Notice tone="danger" role="alert">
          <p className="font-medium">Fix these before creating the job:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {errors.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Panel className="p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <JobForm draft={draft} onChange={patch} people={people} disabled={busy} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className={primary} disabled={busy || !draft.title.trim()}>
              {busy ? "Creating…" : "Create job"}
            </button>
            <Link href="/staff/production" className={subtle}>
              Cancel
            </Link>
          </div>
        </form>
      </Panel>
    </div>
  );
}

export default function NewProductionJobPage() {
  return (
    <Suspense
      fallback={
        <div className="page-container">
          <p className="text-sm text-brand-textMuted" role="status">
            Loading…
          </p>
        </div>
      }
    >
      <NewJobContent />
    </Suspense>
  );
}
