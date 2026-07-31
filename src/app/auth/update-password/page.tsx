"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function UpdatePasswordPage() {
  const supabase = supabaseBrowser();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setReady(Boolean(data.user)));
  }, [supabase]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    if (password.length < 12) return setMessage("Use at least 12 characters.");
    if (password !== confirm) return setMessage("The passwords do not match.");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setMessage("Your password could not be updated. Request a new reset link and try again.");
      return;
    }
    setPassword("");
    setConfirm("");
    setDone(true);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <p className="ui-eyebrow mb-4">Account security</p>
      <section className="ui-card space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-brand-text">Choose a new password</h1>
          <p className="mt-1 text-sm text-brand-textMuted">Use at least 12 characters.</p>
        </div>
        {ready === null ? (
          <p className="text-sm text-brand-textMuted">Checking reset link…</p>
        ) : !ready ? (
          <div className="space-y-3 text-sm text-brand-textMuted">
            <p>This reset link is invalid or has expired.</p>
            <Link href="/auth/forgot-password" className="ui-btn ui-btn-ghost text-xs">Request another link</Link>
          </div>
        ) : done ? (
          <div className="space-y-3">
            <p className="text-sm text-brand-text">Your password has been updated.</p>
            <Link href="/account" className="ui-btn ui-btn-primary text-xs">Go to account</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <label className="block"><span className="ui-label">New password</span><input className="ui-input no-zoom-input" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <label className="block"><span className="ui-label">Confirm password</span><input className="ui-input no-zoom-input" type="password" autoComplete="new-password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
            <button className="ui-btn ui-btn-primary w-full" disabled={busy}>{busy ? "Updating…" : "Update password"}</button>
            {message ? <p className="text-xs text-rose-300">{message}</p> : null}
          </form>
        )}
      </section>
    </div>
  );
}
