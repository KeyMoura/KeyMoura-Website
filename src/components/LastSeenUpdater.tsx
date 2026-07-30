"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

// Updates the current user's last_seen_at periodically.
// This powers the "Active" badge across the site.
export function LastSeenUpdater() {
  useEffect(() => {
    let cancelled = false;

    const touchServerIp = async () => {
      try {
        const now = Date.now();
        const last = Number(localStorage.getItem("ip_log_touch_ms") ?? "0");
        // Throttle server IP logging to once per 6 hours per browser.
        if (Number.isFinite(last) && now - last < 6 * 60 * 60 * 1000) return;

        // The endpoint is authenticated. Avoid generating an expected 401 for
        // every anonymous visitor before attempting this best-effort request.
        const supabase = supabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        const res = await fetch("/api/security/log-session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!res.ok) return;
        localStorage.setItem("ip_log_touch_ms", String(now));
      } catch {
        // ignore (best-effort)
      }
    };

    const touch = async () => {
      try {
        const now = Date.now();
        const last = Number(localStorage.getItem("last_seen_touch_ms") ?? "0");
        // Shared localStorage throttles all tabs to approximately one write per five minutes.
        if (Number.isFinite(last) && now - last < 5 * 60_000) return;

        const supabase = supabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        localStorage.setItem("last_seen_touch_ms", String(now));
        const { error } = await supabase.rpc("touch_last_seen");
        if (error) localStorage.removeItem("last_seen_touch_ms");
      } catch {
        // ignore (best-effort)
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void touch();
    };

    // Initial touch + keep-alive.
    void touch();
    void touchServerIp();
    const interval = window.setInterval(() => void touch(), 5 * 60_000);

    window.addEventListener("focus", touch);
    document.addEventListener("visibilitychange", onVisibility);

    // Also try to refresh the server IP log on focus/visibility.
    window.addEventListener("focus", touchServerIp);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", touch);
      window.removeEventListener("focus", touchServerIp);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
