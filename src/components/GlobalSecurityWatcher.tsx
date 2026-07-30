"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function GlobalSecurityWatcher() {
  useEffect(() => {
    const supabase = supabaseBrowser();

    const checkForceLogout = async () => {
      try {
        const { data, error } = await supabase.rpc("get_site_lockdown_flags");

        if (error || !data || data.length === 0) {
          return;
        }

        const row = data[0] as {
          lockdown_enabled: boolean;
          lockdown_message: string;
          force_logout_epoch: number | null;
          maintenance_mode: boolean;
        };

        const remote = row.force_logout_epoch || 0;

        if (typeof window === "undefined") return;

        const localStr = window.localStorage.getItem(
          "force_logout_epoch_seen"
        );
        const local = localStr ? parseInt(localStr, 10) : 0;

        if (remote > local) {
          // Newer "logout all users" value – sign out this session
          await supabase.auth.signOut();
          window.localStorage.setItem(
            "force_logout_epoch_seen",
            String(remote)
          );
        }
      } catch (e) {
        console.error("GlobalSecurityWatcher error", e);
      }
    };

    void checkForceLogout();
  }, []);

  return null;
}
