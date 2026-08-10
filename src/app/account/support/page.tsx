"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  SUPPORT_CATEGORY_SHORT,
  SUPPORT_STATUS_CUSTOMER_LABELS,
  formatSupportAge,
  type SupportCategory,
  type SupportStatus,
} from "@/lib/support/domain";

/**
 * A customer's own support requests.
 *
 * Everything on this page comes from `/api/support/conversations`, which filters
 * on the session's own user id **in the query**. Nothing here decides what to
 * show; there is nothing to decide, because a row belonging to somebody else is
 * never loaded.
 *
 * The status shown is the *customer* wording from the domain module — "With our
 * team" rather than `waiting_on_staff`. The internal vocabulary is for the
 * inbox; a customer reading "Waiting on staff" about their own refund learns
 * nothing they can act on.
 */

type Row = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  relatedOrderId: string | null;
  relatedOrderNumber: string | null;
  createdAt: string;
  lastMessageAt: string;
};

const TONE: Readonly<Record<SupportStatus, string>> = {
  open: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  waiting_on_staff: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  waiting_on_customer: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  closed: "border-zinc-700 bg-zinc-800/40 text-zinc-300",
};

export default function AccountSupportPage() {
  const [state, setState] = useState<"loading" | "ready" | "error" | "signed-out">("loading");
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    const { data } = await supabaseBrowser().auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setState("signed-out");
      return;
    }
    try {
      const response = await fetch("/api/support/conversations", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("failed");
      const body = (await response.json()) as { conversations: Row[] };
      setRows(body.conversations ?? []);
      setState("ready");
    } catch {
      // A failed load is said out loud rather than rendered as an empty list.
      // "You have no requests" and "we could not find out" must never look the
      // same — this codebase has shipped that confusion on four pages already.
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:py-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.22em] text-brand-primary">Support</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Your requests</h1>
        </div>
        <Link href="/support" className="ui-btn ui-btn-primary">
          New request
        </Link>
      </div>

      {state === "loading" ? (
        <p role="status" className="mt-10 text-brand-textMuted">
          Loading…
        </p>
      ) : null}

      {state === "signed-out" ? (
        <div className="mt-10 rounded-2xl border border-zinc-800 bg-black/30 p-6">
          <p>Sign in to see the requests on your account.</p>
          <Link href="/auth" className="mt-4 inline-flex ui-btn ui-btn-primary">
            Sign in
          </Link>
        </div>
      ) : null}

      {state === "error" ? (
        <div role="alert" className="mt-10 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6">
          <p>We could not load your support requests just now.</p>
          <button type="button" onClick={() => void load()} className="ui-btn ui-btn-secondary mt-4">
            Try again
          </button>
        </div>
      ) : null}

      {state === "ready" && !rows.length ? (
        <div className="mt-10 rounded-2xl border border-zinc-800 bg-black/30 p-6 text-brand-textMuted">
          <p>You have not asked us anything yet.</p>
          <Link href="/support" className="mt-4 inline-flex text-sm font-semibold text-brand-primary hover:underline">
            Start a request →
          </Link>
        </div>
      ) : null}

      {state === "ready" && rows.length ? (
        <ul className="mt-8 space-y-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/account/support/${row.id}`}
                className="block rounded-2xl border border-zinc-800 bg-black/30 p-5 transition hover:border-zinc-600"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-sm text-brand-primary">{row.reference}</span>
                  <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE[row.status]}`}>
                    {SUPPORT_STATUS_CUSTOMER_LABELS[row.status]}
                  </span>
                  <span className="text-xs text-brand-textMuted">{SUPPORT_CATEGORY_SHORT[row.category]}</span>
                </div>
                <p className="mt-2 text-lg font-medium">{row.subject}</p>
                <p className="mt-1 text-sm text-brand-textMuted">
                  Last update {formatSupportAge(row.lastMessageAt)}
                  {row.relatedOrderNumber ? ` · ${row.relatedOrderNumber}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
