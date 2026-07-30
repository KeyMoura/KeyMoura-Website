"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { isRecord, isString } from "@/lib/typeGuards";

type Phase = "idle" | "exchanging" | "success" | "error";

type ExchangeResult = {
  ok: boolean;
  errorMessage: string | null;
};

/**
 * Exchanges a Supabase OAuth `code` for a session in the browser.
 *
 * This route exists because Supabase PKCE verifiers are stored client-side.
 * If the app lands on `/?code=...` (or any page with a `code` query), middleware
 * redirects here so the exchange can complete reliably without being affected by
 * the rest of the application state.
 */
export default function AuthExchangePage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const [code, setCode] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState<string>("/");

  useEffect(() => {
    const url = new URL(window.location.href);
    setCode(url.searchParams.get("code"));
    setNextPath(url.searchParams.get("next") ?? "/");
  }, []);

  useEffect(() => {
    const run = async (): Promise<void> => {
      if (!code) {
        setPhase("error");
        setMessage("Missing OAuth code.");
        return;
      }

      setPhase("exchanging");

      const supabase = supabaseBrowser();
      const timeoutMs = 6000;

      const doExchange = async (): Promise<ExchangeResult> => {
        try {
          const res = await supabase.auth.exchangeCodeForSession(code);

          if (res.error) {
            return { ok: false, errorMessage: res.error.message };
          }

          const session = (await supabase.auth.getSession()).data.session;
          if (!session) {
            return { ok: false, errorMessage: "No session returned after exchange." };
          }

          return { ok: true, errorMessage: null };
        } catch (err: unknown) {
          if (isRecord(err) && isString(err.message)) {
            return { ok: false, errorMessage: err.message };
          }
          return { ok: false, errorMessage: "Exchange failed." };
        }
      };

      const race = await Promise.race([
        doExchange(),
        new Promise<ExchangeResult>((resolve) =>
          setTimeout(() => resolve({ ok: false, errorMessage: "Exchange timed out." }), timeoutMs)
        ),
      ]);

      if (!race.ok) {
        setPhase("error");
        setMessage(race.errorMessage ?? "Exchange failed.");
        return;
      }

      setPhase("success");
      setMessage(null);
      window.location.replace(nextPath);
    };

    void run();
  }, [code, nextPath]);

  const title =
    phase === "exchanging"
      ? "Finishing sign in…"
      : phase === "success"
      ? "Signed in"
      : phase === "error"
      ? "Sign in failed"
      : "Signing in…";

  return (
    <div className="mx-auto flex max-w-lg flex-col px-4 py-14">
      <div className="mb-4 text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Account</div>

      <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-6 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold text-brand-text">{title}</h1>

        {phase === "exchanging" ? (
          <p className="text-sm text-brand-textMuted">Completing the secure session handshake…</p>
        ) : null}

        {phase === "error" ? (
          <>
            <p className="mt-2 text-sm text-red-400">{message ?? "Unable to finish signing in."}</p>
            <p className="mt-3 text-[12px] text-brand-textMuted">
              This usually means your auth redirect URL or PKCE verifier didn&apos;t match the browser session.
            </p>

            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/auth/login"
                className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-medium text-brand-text transition hover:bg-zinc-900"
              >
                Back to login
              </Link>
              <Link
                href="/"
                className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-medium text-brand-text transition hover:bg-zinc-900"
              >
                Go home
              </Link>
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-4 text-[11px] text-brand-textMuted">
        If this keeps happening, confirm your Supabase Auth redirect URLs include your domain.
      </div>
    </div>
  );
}
