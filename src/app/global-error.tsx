"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-black text-white">
        <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-6 text-center">
          <p className="text-sm uppercase tracking-[0.2em] text-amber-400">KeyMoura</p>
          <h1 className="mt-3 text-3xl font-semibold">Something went wrong</h1>
          <p className="mt-3 text-zinc-400">The error was reported. Reload the page, or return in a moment.</p>
          <button className="mx-auto mt-6 rounded-lg bg-amber-400 px-5 py-3 font-semibold text-black" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </main>
      </body>
    </html>
  );
}
