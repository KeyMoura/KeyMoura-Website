"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GUEST_CODE_LENGTH, GUEST_CODE_TTL_LABEL } from "@/lib/commerce/guestAccessWindow";

/**
 * The gate a guest sees when this browser cannot already open their order.
 *
 * ## Why this is a form and not an error page
 *
 * Every denial that is not an infrastructure failure lands here — no cookie,
 * the wrong cookie, an expired session, an order id that does not exist. They
 * render identically on purpose: a page that said "that order is not yours"
 * for a real id and "not found" for a fake one would answer, for anyone willing
 * to try ids, which ones are real. So the honest, unhelpful-to-an-attacker
 * answer is the same for all of them — prove the mailbox.
 *
 * ## Why the first code is requested on mount
 *
 * A guest arriving from a link on their laptop should not have to press "send
 * me a code" before anything happens. But an automatic send is also how an
 * inbox gets flooded by a held-down refresh key, so the request the page makes
 * is *ensure*, not *send*: the server replies with the masked address and sends
 * no email when a usable challenge already exists. Only the explicit button
 * below asks for a replacement, and only that is governed by the cooldown.
 *
 * The ref guard stops React strict mode's double-invoke from making two
 * requests; the server-side rule is what actually guarantees one email.
 */

/** Mirrors `GUEST_CODE_RESEND_SECONDS`; the server is the authority either way. */
const RESEND_SECONDS = 60;
const CODE_LENGTH = GUEST_CODE_LENGTH;

type Phase = "loading" | "ready" | "unavailable";

export function GuestOrderVerification({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const requested = useRef(false);

  const requestCode = useCallback(
    async (resend: boolean) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const response = await fetch(`/api/orders/guest/${orderId}/verification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resend }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
          maskedEmail?: string;
          sent?: boolean;
          alreadySent?: boolean;
        };

        if (response.status === 503) {
          // Verification cannot run. Say so plainly, and stop offering a form
          // that could only fail — never mention why.
          setPhase("unavailable");
          setError(result.error || "Order verification is temporarily unavailable.");
          return;
        }

        setPhase("ready");
        if (!response.ok) {
          if (response.status === 429) setCooldown(RESEND_SECONDS);
          setError(result.error || "We could not send a code. Please try again in a moment.");
          return;
        }

        if (result.maskedEmail) setMaskedEmail(result.maskedEmail);
        if (result.sent) {
          setCooldown(RESEND_SECONDS);
          setNotice(resend ? "A new code is on its way." : "");
        } else if (result.alreadySent && resend === false) {
          setNotice("");
        }
      } catch {
        setPhase("ready");
        setError("We could not reach the server. Please check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [orderId]
  );

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void requestCode(false);
  }, [requestCode]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/orders/guest/${orderId}/verification`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 503) {
        setPhase("unavailable");
        setError(result.error || "Order verification is temporarily unavailable.");
        return;
      }
      if (!response.ok) {
        setError(result.error || "That code is not right. Check the digits and try again.");
        setCode("");
        return;
      }
      // The session cookie is set; the server component can now resolve the
      // order. `refresh` re-runs it in place rather than navigating.
      router.refresh();
    } catch {
      setError("We could not reach the server. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "unavailable") {
    return (
      <main className="page-container">
        <section className="ui-card mx-auto mt-10 max-w-lg p-6" aria-labelledby="order-access-title">
          <h1 id="order-access-title" className="text-2xl font-semibold tracking-tight">
            Order access
          </h1>
          <p role="alert" className="ui-notice mt-4">
            {error}
          </p>
          <div className="ui-action-row mt-6">
            <a href="/support" className="ui-btn ui-btn-primary">
              Contact support
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="page-container">
      <section className="ui-card mx-auto mt-10 max-w-lg p-6" aria-labelledby="order-access-title">
        <h1 id="order-access-title" className="text-2xl font-semibold tracking-tight">
          Order access
        </h1>
        <p className="mt-3 leading-7 text-brand-textMuted">
          Enter the {CODE_LENGTH}-digit code sent to your email.
        </p>

        {/* Only ever the masked address. Announced politely so a screen reader
            hears it arrive without losing the user's place in the form. */}
        <p className="mt-2 min-h-6 text-sm text-brand-textMuted" aria-live="polite">
          {phase === "loading"
            ? "Checking…"
            : maskedEmail
              ? `Code sent to ${maskedEmail}`
              : ""}
        </p>

        <form onSubmit={verify} className="mt-5 grid gap-4">
          <label htmlFor="guest-order-code" className="font-medium">
            Verification code
          </label>
          <input
            id="guest-order-code"
            name="code"
            className="ui-input text-center text-2xl tracking-[.35em]"
            value={code}
            /* Strip non-digits rather than reject: a pasted "123 456" or
               "123-456" from a mail client becomes a valid entry instead of a
               validation error the customer has to decode. */
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern={`[0-9]{${CODE_LENGTH}}`}
            maxLength={CODE_LENGTH}
            autoFocus
            required
            aria-describedby={error ? "guest-code-error" : undefined}
            aria-invalid={error ? true : undefined}
          />

          {error ? (
            <p id="guest-code-error" role="alert" className="ui-notice ui-notice-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="ui-notice ui-notice-success">
              {notice}
            </p>
          ) : null}

          <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || code.length !== CODE_LENGTH}>
            {busy ? "Checking…" : "Verify"}
          </button>
        </form>

        <button
          type="button"
          className="ui-btn ui-btn-ghost mt-3 w-full"
          onClick={() => void requestCode(true)}
          disabled={busy || cooldown > 0}
        >
          {cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
        </button>

        <p className="mt-4 text-xs leading-6 text-brand-textMuted">
          Codes expire after {GUEST_CODE_TTL_LABEL}. If you cannot find the email, check your spam folder or{" "}
          <a href="/support" className="underline hover:text-brand-primary">
            contact support
          </a>
          .
        </p>
      </section>
    </main>
  );
}
