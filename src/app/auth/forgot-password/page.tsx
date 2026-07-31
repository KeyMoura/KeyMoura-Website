"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function ForgotPasswordPage() {
  const supabase = supabaseBrowser();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/auth/update-password")}`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo }
    );
    setBusy(false);
    if (resetError) {
      setError("We couldn't send the reset email. Please try again shortly.");
      return;
    }
    setSent(true);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <p className="ui-eyebrow mb-4">Account security</p>
      <section className="ui-card space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-brand-text">Reset your password</h1>
          <p className="mt-1 text-sm text-brand-textMuted">
            Enter your account email and we&apos;ll send a secure reset link.
          </p>
        </div>
        {sent ? (
          <div className="space-y-3">
            <p className="text-sm text-brand-text">
              If an account can receive password resets at that address, the email is on its way.
            </p>
            <Link href="/auth/login" className="ui-btn ui-btn-ghost text-xs">Back to login</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block">
              <span className="ui-label">Email</span>
              <input className="ui-input no-zoom-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button className="ui-btn ui-btn-primary w-full" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
            {error ? <p className="text-xs text-rose-300">{error}</p> : null}
          </form>
        )}
      </section>
    </div>
  );
}
