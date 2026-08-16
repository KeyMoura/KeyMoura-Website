// src/components/SiteBroadcastBanner.tsx
"use client";

import { useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";
import { supabaseBrowser } from "@/lib/supabaseClient";

type BannerLevel = "info" | "warning" | "critical";

type FlagsRow = {
  emergency_banner_enabled: boolean;
  emergency_banner_text: string | null;
  emergency_banner_level: string | null;
};

export default function SiteBroadcastBanner() {
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState<string>("");
  const [level, setLevel] = useState<BannerLevel>("info");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data, error } = await supabase.rpc(
          "get_site_lockdown_flags"
        );

        if (error) {
          console.error(
            "SiteBroadcastBanner: get_site_lockdown_flags error",
            error
          );
          return;
        }

        if (!data || !Array.isArray(data) || data.length === 0) return;

        const row = data[0] as FlagsRow;

        const isEnabled = !!row.emergency_banner_enabled;
        const bannerText = row.emergency_banner_text ?? "";
        const lvlRaw = (row.emergency_banner_level ?? "info") as string;
        const lvl: BannerLevel = ["info", "warning", "critical"].includes(
          lvlRaw
        )
          ? (lvlRaw as BannerLevel)
          : "info";

        setEnabled(isEnabled && bannerText.trim().length > 0);
        setText(bannerText);
        setLevel(lvl);
        setDismissed(false);
      } catch (e) {
        console.error("SiteBroadcastBanner: unexpected error", e);
      }
    };

    void load();
  }, []);

  const handleClose = () => {
    setDismissed(true);
  };

  if (!enabled || !text.trim() || dismissed) return null;

  const label = level === "critical" ? "Critical" : level === "warning" ? "Warning" : "Notice";

  return (
    /*
     * Rebuilt on the announcement bar's layout, and deliberately not merged with
     * it. This is the *security* broadcast: it is written on /staff/security
     * beside the lockdown password, it carries a severity, and it exists to say
     * "we are aware, we are working on it" on every page at once.
     *
     * What changed is only how it looks. It kept its own severity colours —
     * those are the one place on this site where red means red — but it no
     * longer draws a centred sentence between a boxed `INFO` chip and a ringed
     * `×`, because that was the shape the shop had been using to advertise a
     * launch date. With a real announcement bar above it, this can go back to
     * looking like what it is.
     *
     * `role="status"` rather than `alert`: an operator enabling this while
     * somebody is mid-checkout should not interrupt their screen reader, and the
     * banner is present on the next page they load either way.
     */
    <aside
      className="announcement-bar site-broadcast-bar"
      data-level={level}
      role="status"
      aria-label="Site notice"
      data-testid="site-broadcast-banner"
    >
      <div className="announcement-bar-inner">
        <span className="announcement-bar-label">{label}</span>
        <p className="announcement-bar-message">{text}</p>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Dismiss notice"
          className="announcement-bar-close"
        >
          <FontAwesomeIcon icon={faXmark} className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
