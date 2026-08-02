"use client";

import * as Sentry from "@sentry/nextjs";
import { useState } from "react";

export function SentryTestPanel() {
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);

  const sendTest = async () => {
    setSending(true);
    setStatus("Sending browser and server test events…");
    const browserError = new Error("KeyMoura staff browser monitoring test");
    const eventId = Sentry.captureException(browserError, { tags: { source: "staff-monitoring-test" } });
    const response = await fetch("/api/staff/monitoring/test", { method: "POST" });
    const result = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    setSending(false);
    setStatus(response.ok && result?.ok
      ? `Test events sent. Browser event: ${eventId}. Check Sentry Issues in about a minute.`
      : result?.error || "The monitoring test could not be sent.");
  };

  return (
    <section className="ui-card">
      <p className="ui-eyebrow">Production monitoring</p>
      <h2 className="mt-1 text-xl font-semibold">Sentry connection test</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-textMuted">Send controlled browser and server events without breaking a real page or exposing customer data.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void sendTest()} disabled={sending} className="ui-btn ui-btn-secondary">{sending ? "Sending…" : "Send test events"}</button>
        {status ? <p className="text-xs leading-5 text-brand-textMuted" role="status">{status}</p> : null}
      </div>
    </section>
  );
}
