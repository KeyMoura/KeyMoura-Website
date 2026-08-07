"use client";

import { useRef, useState } from "react";
import { Notice } from "@/components/ui/DesignSystem";
import type { GuestOrderMessage } from "@/lib/commerce/guestOrderAccess";

type GuestOrderActionsProps = {
  orderId: string;
  messages: GuestOrderMessage[];
  /** True only when the server has said there is a balance to pay. */
  payable: boolean;
  amountDueLabel: string | null;
};

/**
 * A guest answering a question and paying an approved quote.
 *
 * Both actions post to guest-only routes that authenticate on the httpOnly
 * cookie. Nothing here decides what is allowed: `payable` comes from the
 * server's own reading of the order, and the pay route re-derives the amount
 * from the order row without reading a single field of the request body.
 *
 * The double-submit guard is a **ref, not state**, for the reason pass 11
 * established: `pending` as React state is stale for two clicks inside one
 * batch, so two clicks would both pass the check. `inFlight` is read and set
 * synchronously.
 */
export default function GuestOrderActions({ orderId, messages, payable, amountDueLabel }: GuestOrderActionsProps) {
  const [body, setBody] = useState("");
  const [sent, setSent] = useState<GuestOrderMessage[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** Minted once per composed message, so a retry collapses to one row. */
  const clientToken = useRef(crypto.randomUUID());

  async function send() {
    if (inFlight.current) return;
    const text = body.trim();
    if (!text) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/guest/${orderId}/messages`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text, client_token: clientToken.current }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        setError(payload?.error || "That message could not be sent. Please try again.");
        return;
      }
      setSent((current) => [
        ...current,
        { id: Date.now(), body: text, created_at: new Date().toISOString(), fromStaff: false },
      ]);
      setBody("");
      clientToken.current = crypto.randomUUID();
    } catch {
      setError("That message could not be sent. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function pay() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/guest/${orderId}/checkout`, {
        method: "POST",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !payload?.url) {
        setError(payload?.error || "Checkout could not be started. Please try again.");
        return;
      }
      window.location.href = payload.url;
    } catch {
      setError("Checkout could not be started. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const thread = [...messages, ...sent];

  return (
    <>
      {payable ? (
        <section className="ui-card mt-4 p-5">
          <h2 className="text-lg font-semibold">Your quote is ready</h2>
          <p className="mt-2 text-sm leading-6 text-brand-textMuted">
            {amountDueLabel
              ? `${amountDueLabel} is due to start this order. Nothing is charged until you complete payment.`
              : "Nothing is charged until you complete payment."}
          </p>
          <button
            type="button"
            onClick={() => void pay()}
            disabled={busy}
            className="ui-btn ui-btn-primary mt-4 disabled:opacity-50"
          >
            {busy ? "Starting checkout…" : "Pay now"}
          </button>
        </section>
      ) : null}

      <section aria-labelledby="guest-order-messages" className="ui-card mt-4 p-5">
        <h2 id="guest-order-messages" className="text-lg font-semibold">
          Messages
        </h2>

        {thread.length ? (
          <ul className="mt-4 grid gap-3">
            {thread.map((message) => (
              <li
                key={`${message.id}-${message.created_at}`}
                className={`rounded-xl border border-brand-border p-3 ${message.fromStaff ? "bg-black/20" : ""}`}
              >
                <p className="text-xs text-brand-textMuted">
                  {message.fromStaff ? "KeyMoura" : "You"} ·{" "}
                  {new Date(message.created_at).toLocaleString()}
                </p>
                {/* Plain text. A customer's and a staff member's words are
                    rendered as text, never as markup. */}
                <p className="mt-1 whitespace-pre-wrap text-sm">{message.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-brand-textMuted">
            No messages yet. Ask anything about this order here — we reply by email too.
          </p>
        )}

        <label className="mt-4 block text-sm">
          Write a message
          <textarea
            className="ui-input mt-1 min-h-24 w-full"
            value={body}
            maxLength={4000}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Answer a question, or add anything we should know."
          />
        </label>

        {error ? (
          <Notice tone="danger" role="alert" className="mt-3">
            {error}
          </Notice>
        ) : null}

        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !body.trim()}
          className="ui-btn ui-btn-secondary mt-3 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send message"}
        </button>
      </section>
    </>
  );
}
