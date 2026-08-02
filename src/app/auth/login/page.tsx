"use client";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { FormEvent, useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const supabase = supabaseBrowser();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailMode, setEmailMode] = useState<"password" | "magic-link">("password");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Clears local auth state in case cookies/storage become inconsistent.
   */
  const resetLocalAuthState = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      
    }

    if (typeof window === "undefined") return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (k.startsWith("sb-") || k.includes("supabase")) keys.push(k);
      }
      for (const k of keys) window.localStorage.removeItem(k);
    } catch {
      
    }
  };

  const handleEmailLogin = async () => {
    setError(null);

    if (!email) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : undefined;

    const response = await fetch("/api/auth/otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, redirectTo }),
    });
    const error = response.ok ? null : new Error("OTP request failed");

    setLoading(false);

    if (error) {
      console.error(error);
      setError("Failed to send login email. Please try again.");
      return;
    }

    setSent(true);
  };

  const handlePasswordLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const response = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setLoading(false);
    if (!response.ok) {
      setError(body?.error ?? "Login failed. Please try again.");
      return;
    }
    const requested = new URLSearchParams(window.location.search).get("next");
    const next = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/account";
    window.location.assign(next);
  };

  const handleOAuth = async (provider: "google" | "discord") => {
    setError(null);
    setLoading(true);

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback`
        : undefined;

    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
    });

    if (error) {
      console.error(error);
      setError("Login failed. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-14">
      <div className="mb-4 text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
        Account
      </div>
      <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-6 shadow-sm">
        {sent ? (
          <div className="text-center">
            <h1 className="mb-2 text-xl font-semibold text-brand-text">
              Check your email
            </h1>

            <p className="mb-4 text-sm text-brand-textMuted">
              We sent a secure login link to:
            </p>

            <div className="mb-5 rounded-lg border border-brand-primary/40 bg-brand-primary/10 px-4 py-3 text-sm font-medium text-brand-primary">
              {email}
            </div>

            <p className="text-[12px] text-brand-textMuted">
              Click the link in the email to finish signing in.
              <br />
              You can close this tab.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => handleOAuth("google")}
                disabled={loading}
                className="inline-flex w-full items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-medium text-brand-text transition hover:bg-zinc-900 disabled:opacity-60"
              >
                Continue with Google
              </button>

              <button
                type="button"
                onClick={() => handleOAuth("discord")}
                disabled={loading}
                className="inline-flex w-full items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-medium text-brand-text transition hover:bg-zinc-900 disabled:opacity-60"
              >
                Continue with Discord
              </button>
            </div>

            <div className="my-4 flex items-center gap-3 text-[10px] uppercase tracking-widest text-brand-textMuted">
              <div className="h-px flex-1 bg-zinc-800" />
              or
              <div className="h-px flex-1 bg-zinc-800" />
            </div>

            <h1 className="mb-2 text-xl font-semibold text-brand-text">Log in with email</h1>
            <div className="ui-tabs mb-4" role="tablist" aria-label="Email login method">
              <button type="button" className={`ui-tab ${emailMode === "password" ? "is-active" : ""}`} onClick={() => { setEmailMode("password"); setError(null); }}>Password</button>
              <button type="button" className={`ui-tab ${emailMode === "magic-link" ? "is-active" : ""}`} onClick={() => { setEmailMode("magic-link"); setError(null); }}>Email link</button>
            </div>

            {emailMode === "password" ? (
              <form onSubmit={handlePasswordLogin} className="space-y-3">
                <label className="block"><span className="ui-label">Email</span><input className="ui-input no-zoom-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} /></label>
                <label className="block"><span className="ui-label">Password</span><input className="ui-input no-zoom-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} /></label>
                <div className="flex items-center justify-between gap-3">
                  <Link href="/auth/forgot-password" className="text-xs font-medium text-brand-primary hover:underline">Forgot password?</Link>
                </div>
                <button className="ui-btn ui-btn-primary w-full" disabled={loading}>{loading ? "Logging in…" : "Log in"}</button>
              </form>
            ) : (
              <div className="space-y-3">
                <p className="text-[12px] text-brand-textMuted">We&apos;ll email you a secure one-time login link. No password needed.</p>
                <label className="block"><span className="ui-label">Email</span><input className="ui-input no-zoom-input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} /></label>
                <button type="button" onClick={handleEmailLogin} disabled={loading || email.trim().length < 4} className="ui-btn ui-btn-primary w-full">{loading ? "Sending…" : "Send login link"}</button>
              </div>
            )}

            {error && (
              <p className="mt-3 text-[11px] text-red-400">{error}</p>
            )}
          </>
        )}
      </div>
      <div className="mt-4 text-[11px] text-brand-textMuted">
        <span className="opacity-80">Back to </span>
        <Link
          href="/"
          className="font-medium text-brand-primary hover:text-brand-primarySoft"
        >
          home
        </Link>
        <span className="opacity-80"> or </span>
        <Link
          href="/projects"
          className="font-medium text-brand-primary hover:text-brand-primarySoft"
        >
          browse info pages
        </Link>
        .
      </div>

      <button
        type="button"
        onClick={() => void resetLocalAuthState()}
        className="mt-4 cursor-pointer pointer-events-auto text-left text-[11px] text-brand-textMuted underline decoration-zinc-700 underline-offset-4 hover:text-brand-text"
      >
        Having trouble logging in? Clear local session
      </button>
    </div>
  );
}
