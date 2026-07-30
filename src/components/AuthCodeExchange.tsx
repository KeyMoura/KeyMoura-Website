"use client";

import { useEffect, useRef } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * Exchanges a Supabase OAuth `code` in the browser and then cleans the URL.
 *
 * Notes:
 * - Supabase PKCE uses a client-side verifier, so the exchange must happen in the browser.
 * - This component intentionally avoids `useSearchParams()` to prevent prerender/CSR bailout issues
 *   on special routes (e.g. `/_not-found`).
 */
export default function AuthCodeExchange() {
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return;

    const run = async () => {
      const supabase = supabaseBrowser();
      try {
        await supabase.auth.exchangeCodeForSession(code);
      } catch {
      }

      url.searchParams.delete("code");
      url.searchParams.delete("error");
      url.searchParams.delete("error_code");
      url.searchParams.delete("error_description");

      const clean = url.pathname + (url.search ? url.search : "") + url.hash;
      window.history.replaceState(null, "", clean);

      window.location.reload();
    };

    void run();
  }, []);

  return null;
}
