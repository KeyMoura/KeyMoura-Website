"use client";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { useState } from "react";
import Link from "next/link";

export default function LoginPage() {
  const supabase = supabaseBrowser();

  const [email, setEmail] = useState("");
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

            <h1 className="mb-2 text-xl font-semibold text-brand-text">
              Log in with email
            </h1>

            <p className="mb-4 text-[12px] text-brand-textMuted">
              We&apos;ll email you a secure one-time login link.
            </p>

            <label
              htmlFor="email"
              className="mb-1 block text-[11px] font-medium text-brand-textMuted"
            >
              Email
            </label>

            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              className="mb-3 no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
            />

            <button
              type="button"
              onClick={handleEmailLogin}
              disabled={loading || email.trim().length < 4}
              className="inline-flex w-full items-center justify-center rounded-full border border-white bg-white px-4 py-2 text-sm font-medium text-black shadow-sm shadow-black/60 transition hover:bg-zinc-200 active:bg-zinc-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Sending…" : "Send login link"}
            </button>

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
          href="/info"
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
