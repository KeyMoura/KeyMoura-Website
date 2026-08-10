"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  MAX_SUPPORT_MESSAGE_LENGTH,
  MAX_SUPPORT_SUBJECT_LENGTH,
  ORDER_LEANING_CATEGORIES,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_HELP,
  SUPPORT_CATEGORY_LABELS,
  isSupportCategory,
  type SupportCategory,
} from "@/lib/support/domain";

/**
 * The support form.
 *
 * ## Two audiences, one form
 *
 * A signed-in customer is not asked for their name or email — the server takes
 * both from their session and would ignore anything typed here anyway. A guest
 * is asked for both, because there is no other way to reply to them.
 *
 * ## The order picker
 *
 * Only shown to a signed-in customer, and populated by reading `orders` **through
 * RLS with their own session** — the `customers read own orders` policy means
 * the query can only ever return their rows, so no endpoint has to be written
 * and no id has to be trusted. A guest sees no picker: the browser cannot read
 * an order for them, and the server verifies the id in the URL against their
 * guest session cookie instead.
 *
 * The picker appears for every category, not only the order-ish ones. It is
 * *prompted* for those — a person who cannot find their order is exactly the
 * person opening a Return request without one, and hiding the field from them
 * would be the wrong way round.
 */

type OrderOption = { id: string; label: string };

const input =
  "mt-1 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary";

/** A per-composition token, so a double click is one request and one conversation. */
function newToken(): string {
  return `sup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function SupportRequestForm({
  initialOrderId,
  initialCategory,
}: {
  initialOrderId: string | null;
  initialCategory: string | null;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [category, setCategory] = useState<SupportCategory>(
    isSupportCategory(initialCategory) ? initialCategory : "general"
  );
  const [orderId, setOrderId] = useState(initialOrderId ?? "");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ reference: string | null; href: string | null } | null>(null);
  const [token, setToken] = useState(newToken);

  useEffect(() => {
    let live = true;
    void (async () => {
      const supabase = supabaseBrowser();
      const { data } = await supabase.auth.getUser();
      if (!live) return;
      const user = data.user ?? null;
      setSignedIn(Boolean(user));
      if (!user) return;

      // RLS does the filtering. `customer_id` is not passed and could not help:
      // the policy allows a customer their own rows and nothing else.
      const { data: rows } = await supabase
        .from("orders")
        .select("id,order_number,product_name,created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!live) return;
      setOrders(
        ((rows ?? []) as { id: string; order_number: string | null; product_name: string }[]).map((row) => ({
          id: row.id,
          label: `${row.order_number ?? "Request"} — ${row.product_name}`,
        }))
      );
    })();
    return () => {
      live = false;
    };
  }, []);

  const suggestsOrder = useMemo(
    () => (ORDER_LEANING_CATEGORIES as readonly string[]).includes(category),
    [category]
  );

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setStatus("sending");
      setMessage("");

      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;

      try {
        const response = await fetch("/api/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject: values.subject,
            message: values.message,
            category,
            orderId: orderId || undefined,
            name: values.name,
            email: values.email,
            website: values.website,
            clientToken: token,
          }),
        });
        const body = (await response.json()) as {
          error?: string;
          reference?: string | null;
          href?: string | null;
        };
        if (!response.ok) throw new Error(body.error || "Could not send your request.");

        form.reset();
        setOrderId("");
        // A new token for the next composition, so a second genuine request is
        // not collapsed into the first.
        setToken(newToken());
        setResult({ reference: body.reference ?? null, href: body.href ?? null });
        setStatus("sent");
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Could not send your request.");
      }
    },
    [category, orderId, token]
  );

  if (status === "sent") {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-black/30 p-5 sm:p-7" role="status">
        <h2 className="text-2xl font-semibold">Request received</h2>
        {result?.reference ? (
          <p className="mt-3 text-lg">
            Your reference is <span className="font-semibold text-brand-primary">{result.reference}</span>.
          </p>
        ) : null}
        <p className="mt-3 leading-7 text-brand-textMuted">
          We have emailed you a copy. Someone will reply as soon as they can — you do not need to do anything else.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          {result?.href ? (
            <Link href={result.href} className="ui-btn ui-btn-primary">
              Open this request
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setStatus("idle");
            }}
            className="ui-btn ui-btn-secondary"
          >
            Send another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-black/30 p-5 sm:p-7">
      <label className="block text-sm">
        What can we help with?
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as SupportCategory)}
          className={input}
          name="categoryDisplay"
        >
          {SUPPORT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {SUPPORT_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-sm text-brand-textMuted">{SUPPORT_CATEGORY_HELP[category]}</p>

      {/*
        Rendered only once the session is known. Showing name and email fields to
        a signed-in customer for a beat and then removing them is worse than a
        moment of nothing, and showing nothing to a guest would be worse still.
      */}
      {signedIn === false ? (
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            Your name
            <input name="name" required maxLength={100} autoComplete="name" className={input} />
          </label>
          <label className="text-sm">
            Email
            <input name="email" required type="email" maxLength={254} autoComplete="email" className={input} />
          </label>
        </div>
      ) : null}

      <label className="mt-5 block text-sm">
        Subject
        <input name="subject" required maxLength={MAX_SUPPORT_SUBJECT_LENGTH} className={input} />
      </label>

      <label className="mt-5 block text-sm">
        Message
        <textarea
          name="message"
          required
          minLength={10}
          maxLength={MAX_SUPPORT_MESSAGE_LENGTH}
          className={`${input} min-h-40`}
          placeholder="What is happening, and what would help?"
        />
      </label>

      {signedIn && orders.length ? (
        <label className="mt-5 block text-sm">
          Related order <span className="text-brand-textMuted">(optional)</span>
          <select value={orderId} onChange={(event) => setOrderId(event.target.value)} className={input}>
            <option value="">Not about a specific order</option>
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.label}
              </option>
            ))}
          </select>
          {suggestsOrder && !orderId ? (
            <span className="mt-2 block text-sm text-brand-textMuted">
              Attaching the order helps — but send it anyway if you cannot find it.
            </span>
          ) : null}
        </label>
      ) : null}

      {/*
        A guest who followed the link from their own order page. The id is shown
        as a fact rather than an editable field: they cannot change which order
        their session opens, and the server checks the cookie regardless.
      */}
      {signedIn === false && orderId ? (
        <p className="mt-5 rounded-xl border border-zinc-800 bg-black/20 px-3 py-2.5 text-sm text-brand-textMuted">
          This request will be attached to the order you came from.
        </p>
      ) : null}

      <label className="hidden" aria-hidden="true">
        Company website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>

      {message ? (
        <p role="alert" className="mt-4 text-sm text-rose-200">
          {message}
        </p>
      ) : null}

      <button
        disabled={status === "sending"}
        className="catalog-action-primary mt-6 rounded-full px-6 py-3 font-semibold disabled:opacity-60"
      >
        {status === "sending" ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}
