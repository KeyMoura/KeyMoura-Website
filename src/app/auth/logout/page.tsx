"use client";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { useState } from "react";
import Link from "next/link";

export default function LogoutPage() {
  const supabase = supabaseBrowser();
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
    setLoading(true);
    setMessage(null);

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Error signing out", error);
      setMessage("Error signing out. Please try again.");
    } else {
      setMessage("Signed out successfully.");
    }

    setLoading(false);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-10">
      <div className="mb-4 text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
        Account
      </div>

      <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold text-brand-text">
          Log out
        </h1>
        <p className="mb-4 text-[12px] text-brand-textMuted">
          This will sign you out of your account on this browser.
        </p>

        <button
          type="button"
          onClick={handleLogout}
          disabled={loading}
          className="inline-flex w-full items-center justify-center rounded-full border border-white bg-white px-4 py-2 text-sm font-medium text-black shadow-sm shadow-black/60 transition hover:bg-zinc-200 active:bg-zinc-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Signing out..." : "Sign out"}
        </button>

        {message && (
          <p className="mt-3 text-[11px] text-brand-textMuted">{message}</p>
        )}
      </div>

      {/* FIXED: use <Link> for page navigation */}
      <div className="mt-4 text-[11px] text-brand-textMuted">
        <span className="opacity-80">Go back to </span>
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
    </div>
  );
}
