"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function GuestOrderVerification({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const requestedInitialCode = useRef(false);

  useEffect(() => {
    if (requestedInitialCode.current) return;
    requestedInitialCode.current = true;
    void sendCode();
    // The order id is immutable for this mounted route. The ref prevents
    // React strict mode from sending twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (!cooldown) return; const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, [cooldown]);

  async function sendCode() {
    setBusy(true); setError("");
    const response = await fetch(`/api/orders/guest/${orderId}/verification`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not send a code.");
    else { setMaskedEmail(result.maskedEmail || ""); setCooldown(60); }
    setBusy(false);
  }

  async function verify(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const response = await fetch(`/api/orders/guest/${orderId}/verification`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Invalid verification code.");
    else router.refresh();
    setBusy(false);
  }

  return <main className="page-container"><section className="ui-card mx-auto max-w-lg p-6" aria-labelledby="order-access-title">
    <h1 id="order-access-title" className="text-3xl font-semibold">Order access</h1>
    <p className="mt-3 text-brand-textMuted">Enter the 6-digit code sent to your email.</p>
    {maskedEmail ? <p className="mt-2 text-sm text-brand-textMuted">Code sent to {maskedEmail}</p> : null}
    <form onSubmit={verify} className="mt-6 grid gap-4">
      <label htmlFor="guest-order-code" className="font-medium">Verification code</label>
      <input id="guest-order-code" className="ui-input text-center text-2xl tracking-[.35em]" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required aria-describedby={error ? "guest-code-error" : undefined} />
      {error ? <p id="guest-code-error" role="alert" className="ui-notice ui-notice-danger">{error}</p> : null}
      <button className="ui-btn ui-btn-primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Verify"}</button>
    </form>
    <button type="button" className="ui-btn ui-btn-ghost mt-3" onClick={sendCode} disabled={busy || cooldown > 0}>{busy ? "Sending…" : cooldown ? `Send a new code (${cooldown}s)` : "Send a new code"}</button>
  </section></main>;
}
